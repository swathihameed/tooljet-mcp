#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_HOST = `${process.env.TOOLJET_HOST}`;

// Cache of appId -> signed JWT, so we only do the PAT -> session exchange once per app.
const sessionJwtCache = new Map<string, string>();

// Exchange the static TOOLJET_ACCESS_TOKEN for a short-lived PAT, then exchange that PAT
// for a signed JWT scoped to the given app. The AI conversation endpoints are guarded by
// JwtAuthGuard, which reads the JWT from the `tj_auth_token` header, not the Basic-auth
// token used by the /api/ext/* admin endpoints.
async function getSessionJwt(appId: string): Promise<string> {
  const cached = sessionJwtCache.get(appId);
  if (cached) {
    return cached;
  }

  const patUrl = `${API_HOST}/api/ext/users/personal-access-token`;
  const patResponse = await fetch(patUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${process.env.TOOLJET_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      email: process.env.TOOLJET_USER_EMAIL,
      appId,
    }),
  });
  if (!patResponse.ok) {
    throw new Error(`Failed to generate PAT: ${patResponse.status} ${await patResponse.text()}`);
  }
  const { personalAccessToken } = (await patResponse.json()) as { personalAccessToken: string };

  const sessionUrl = `${API_HOST}/api/ext/users/session`;
  const sessionResponse = await fetch(sessionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, accessToken: personalAccessToken }),
  });
  if (!sessionResponse.ok) {
    throw new Error(`Failed to create PAT session: ${sessionResponse.status} ${await sessionResponse.text()}`);
  }
  const { signedPat } = (await sessionResponse.json()) as { signedPat: string };

  sessionJwtCache.set(appId, signedPat);
  return signedPat;
}

// Create (or continue) an AI-builder conversation for an app.
async function createConversation(
  appId: string,
  conversationType: string,
  currentConversationId?: string
): Promise<{ id: string; [key: string]: any }> {
  const jwt = await getSessionJwt(appId);
  const response = await fetch(`${API_HOST}/api/ai/conversation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      tj_auth_token: jwt,
    },
    body: JSON.stringify({ appId, conversationType, currentConversationId }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create conversation: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { id: string; [key: string]: any };
}

// Maps the artifact name on an interactive-widget response section to the interrupt `type`
// the backend expects back in `interruptConfig.type` when resuming (server/ee/ai/service.ts).
// Widgets that don't set a distinguishing artifact name (phase-plan approval, phase-complete,
// upgrade gate) all resume through the same generic 'approval_response' shape.
const ARTIFACT_NAME_TO_INTERRUPT_TYPE: Record<string, string> = {
  "datasource-selection": "user_ds_selection",
  entity_schema_review: "user_entity_selection",
  "query-preview": "query_preview_shape",
};

// Inspect the last `update_message` event for an interactive-widget section. If present, the
// conversation is paused awaiting a structured answer — surface what's pending so the caller
// knows what `interrupt_type`/`interrupt_content` to send on the next `build-app` call.
function detectPendingInterrupt(events: Array<{ type: string; data: any }>): any {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "update_message") continue;

    const sections = event.data?.metadata?.sections;
    if (!Array.isArray(sections)) continue;

    const widget = sections.find((s: any) => s?.type === "output-widget-interactive");
    if (!widget) continue;

    const artifactName = widget.header?.artifact?.name;
    const type = (artifactName && ARTIFACT_NAME_TO_INTERRUPT_TYPE[artifactName]) || "approval_response";

    return {
      type,
      suggestions: event.data.metadata.resumeSuggestions ?? widget.responseActions ?? [],
    };
  }
  return null;
}

// Send a build instruction on an existing conversation and consume the SSE stream until
// the `finalMessage` event (or the stream closes). Returns the concatenated text content
// of every `message`/`update_message`/`finalMessage` event, plus a list of file diffs seen.
async function streamUserMessage(
  appId: string,
  conversationId: string,
  content: string,
  interruptConfig?: { type: string; content: any }
): Promise<{
  finalMessage: any;
  events: Array<{ type: string; data: any }>;
  pendingInterrupt: any;
}> {
  const jwt = await getSessionJwt(appId);
  const response = await fetch(`${API_HOST}/api/ai/conversation/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      tj_auth_token: jwt,
    },
    body: JSON.stringify({
      conversationId,
      content,
      references: [],
      ...(interruptConfig ? { interruptConfig } : {}),
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to send message: ${response.status} ${await response.text()}`);
  }

  const events: Array<{ type: string; data: any }> = [];
  let finalMessage: any = null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!eventLine || !dataLine) continue;

      const type = eventLine.slice("event: ".length).trim();
      const rawData = dataLine.slice("data: ".length);
      let data: any;
      try {
        data = JSON.parse(rawData);
      } catch {
        data = rawData;
      }

      if (type === "heartbeat") continue;

      events.push({ type, data });
      if (type === "finalMessage") {
        finalMessage = data;
      }
    }
  }

  return { finalMessage, events, pendingInterrupt: detectPendingInterrupt(events) };
}

// Create server instance
const server = new McpServer({
  name: "tooljet-mcp",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Helper function for making API requests
async function makeRequest<T>(method: string, url: string, data: object): Promise<T | null> {
    const headers = {
        "Content-Type": "application/json",
        "Authorization": `Basic ${process.env.TOOLJET_ACCESS_TOKEN}`
    };
  
    try {
    //   const response = await fetch(url, { headers });

    let requestData = {}

    if(method === "GET"){
        requestData = { 
            method: "GET", // Add the method here
            headers
        }
    }
    else if(method === "POST" || method === "PATCH" || method === "PUT"){
        requestData = { 
            method: method, // Add the method here
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Basic ${process.env.TOOLJET_ACCESS_TOKEN}`
            },
            body: JSON.stringify(data)
        } 
    }

      const response = await fetch(url, requestData);
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
      }
      if(method === "PATCH" || method === "PUT"){
        return response.ok as T;
      }
      return (await response.json()) as T;
    } catch (error) {
      console.error("Error making request:", error);
      return null;
    }
}

  
  // Register get users tools
server.tool(
    "get-all-users",
    "Get all users of a ToolJet instance",
    {
    //   state: "123",
    },
    async ({ }) => {
      const usersUrl = `${API_HOST}/api/ext/users`;
      const usersData = await makeRequest("GET",usersUrl, {});
  
      if (!usersData) {
        return {
          content: [
            {
              type: "text",
              text: "Failed to retrieve users data",
            },
          ],
        };
      }
  
      const users = usersData;
   
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(users),
          },
        ],
      };
    },
);

// Register get workspaces tools
server.tool(
    "get-all-workspaces",
    "Get all workspaces of a ToolJet instance",
    {
    //   state: "123",
    },
    async ({ }) => {
        const workspacesUrl = `${API_HOST}/api/ext/workspaces`;
        const workspacesData = await makeRequest("GET",workspacesUrl, {});
    
        if (!workspacesData) {
        return {
            content: [
            {
                type: "text",
                text: "Failed to retrieve workspaces data",
            },
            ],
        };
        }
    
        const workspaces = workspacesData;
    
        return {
        content: [
            {
            type: "text",
            text: JSON.stringify(workspaces),
            },
        ],
        };
    },
);

// Register get all apps details
server.tool(
    "get-all-apps",
    "Get all apps of a workspace in a ToolJet instance",
    {
      workspace_id: z.string().describe('ID of the workspace for which apps are to be fetched. Always ask the user.'),
    },
    async ({ workspace_id}) => {
        const appsUrl = `${API_HOST}/api/ext/workspace/${workspace_id}/apps`;
        const appsData = await makeRequest("GET",appsUrl, {});
    
        if (!appsData) {
        return {
            content: [
            {
                type: "text",
                text: "Failed to retrieve apps data",
            },
            ],
        };
        }
    
        const apps = appsData;
    
        return {
        content: [
            {
            type: "text",
            text: JSON.stringify(apps),
            },
        ],
        };
    },
);


// Register get user details
server.tool(
    "get-user",
    "Get a user in a ToolJet instance",
    {
      user_id: z.string().describe('ID of the user. Always ask the user.'),
    },
    async ({ user_id}) => {
        const userUrl = `${API_HOST}/api/ext/user/${user_id}`;
        const userData = await makeRequest("GET",userUrl, {});
    
        if (!userData) {
        return {
            content: [
            {
                type: "text",
                text: "Failed to retrieve apps data",
            },
            ],
        };
        }
    
        const user = userData;
    
        return {
        content: [
            {
            type: "text",
            text: JSON.stringify(user),
            },
        ],
        };
    },
);

// Register create user tool
server.tool(
    "create-user",
    "create a user in a given workspace of ToolJet instance",
    {
       user_name: z.string().describe('The name of the user. Always ask the user.'),
       user_email: z.string().describe('The email of the user. Always ask the user.'),
       workspace_name: z.string().describe('Name of the workspace in which user will join. Always ask the user.'),
    },
    async ({ user_name, user_email, workspace_name }) => {
        const usersUrl = `${API_HOST}/api/ext/users`;
        const data = {
            name: user_name,
            email: user_email,
            password: "12343242353252",
            status: "active",
            workspaces: [
                {
                    name: workspace_name
                }
            ]

        }
        const usersData = await makeRequest("POST", usersUrl, data);
    
        if (!usersData) {
        return {
            content: [
            {
                type: "text",
                text: "Failed to create a user",
            },
            ],
        };
        }
    
        const users = usersData;
    
        return {
        content: [
            {
            type: "text",
            text: JSON.stringify(users),
            },
        ],
        };
    },
);

type User = {
    name?: string;
    password?: string;
    status?: string;
};

type UserRole = {
    userId?: string;
    newRole?: string;
};

// Register update user tool
server.tool(
    "update-user",
    "update a user in a given workspace of ToolJet instance",
    {
       user_id: z.string().describe('The id of the user.It can not be changed or updated. Always ask the user.'),
       user_name: z.string().optional().describe('The new name of the user. Always ask the user. It is optional.'),
       password: z.string().optional().describe('The new password of the user. Always ask the user. It is optional.'),
       status: z.string().optional().describe('Status can either be active or archived. Always ask the user.It is optional.'),
    },
    async ({ user_id, user_name, password, status }) => {
        const usersUrl = `${API_HOST}/api/ext/user/${user_id}`;
        const user: User = {};
        if(user_name !== "undefined"){
            user.name = user_name
        }
        if(password !== "undefined"){
            user.password = password
        }
        if(status !== "undefined"){
            user.status = status
        }
        const usersData = await makeRequest("PATCH", usersUrl, user);
    
        if (!usersData) {
        return {
            content: [
            {
                type: "text",
                text: "Failed to update a user",
            },
            ],
        };
        }
    
        const users = usersData;
    
        return {
        content: [
            {
            type: "text",
            text: JSON.stringify(users),
            },
        ],
        };
    },
);

// Register update user role tool
server.tool(
    "update-user-role",
    "update a user role in a given workspace of ToolJet instance",
    {
       workspace_id: z.string().describe('ID of the workspace. Always ask the user.'),
       user_id: z.string().describe('The id of the user.It can not be changed or updated. Always ask the user.'),
       newRole: z.string().describe('The new role of the user. Always ask the user.'),
    },
    async ({ workspace_id, user_id, newRole }) => {
        const usersUrl = `${API_HOST}/api/ext/update-user-role/workspace/${workspace_id}`;
        const user: UserRole = {};
        user.userId = user_id
        user.newRole = newRole
        
        const usersData = await makeRequest("PUT", usersUrl, user);
    
        if (!usersData) {
        return {
            content: [
            {
                type: "text",
                text: "Failed to update role of the user",
            },
            ],
        };
        }
    
        const users = usersData;
    
        return {
        content: [
            {
            type: "text",
            text: JSON.stringify(users),
            },
        ],
        };
    },
);


// Structured answers for a pending interrupt, keyed by `interrupt_type`. Shapes mirror what
// ToolJet's frontend sends back in `interruptConfig.content` for each widget
// (frontend/ee/modules/AiBuilder/components/TooljetAIChat/InteractiveWidget/index.jsx).
const interruptContentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("approval_response"),
    label: z.string().describe("The chosen option's label, e.g. 'Approve & start phase 1' or 'Skip this step'."),
  }),
  z.object({
    type: z.literal("spec_doc_user_update"),
    document: z.string().describe("The full updated specification document text."),
  }),
  z.object({
    type: z.literal("user_ds_selection"),
    selections: z
      .array(
        z.object({
          datasource_id: z.string(),
          datasource_kind: z.string().optional(),
        })
      )
      .describe("The datasource(s) the user selected."),
  }),
  z.object({
    type: z.literal("user_entity_selection"),
    selections: z.array(z.record(z.any())).describe("The table/entity records the user selected."),
  }),
  z.object({
    type: z.literal("query_preview_shape"),
    status: z.enum(["accepted", "declined"]),
    shape: z.record(z.any()).optional().describe("Structure-only digest of the previewed query result."),
  }),
]);

// Register build-app tool: drives the AI app-builder pipeline via a conversation.
server.tool(
    "build-app",
    "Start or continue an AI app-build conversation on a ToolJet app, and send a build/edit instruction to the app builder. " +
      "If a previous call returned `pendingInterrupt`, answer it by passing `interrupt_content` matching its `type` (in addition to `prompt`).",
    {
      app_id: z.string().describe("ID of the app to build/modify. Always ask the user."),
      prompt: z.string().describe("Natural-language instruction describing what to build or change."),
      conversation_id: z
        .string()
        .optional()
        .describe("Existing conversation ID to continue. Omit to start a new build conversation."),
      interrupt_content: interruptContentSchema
        .optional()
        .describe(
          "Structured answer to a pending interrupt reported by a previous call's `pendingInterrupt` field. Omit unless resuming one."
        ),
    },
    async ({ app_id, prompt, conversation_id, interrupt_content }) => {
      try {
        const conversationId =
          conversation_id ?? (await createConversation(app_id, "generate")).id;

        let interruptConfig: { type: string; content: any } | undefined;
        if (interrupt_content) {
          switch (interrupt_content.type) {
            case "approval_response":
              interruptConfig = {
                type: interrupt_content.type,
                content: { selectedLabel: interrupt_content.label, action: interrupt_content.label },
              };
              break;
            case "spec_doc_user_update":
              interruptConfig = { type: interrupt_content.type, content: interrupt_content.document };
              break;
            case "user_ds_selection":
              interruptConfig = { type: interrupt_content.type, content: interrupt_content.selections };
              break;
            case "user_entity_selection":
              interruptConfig = { type: interrupt_content.type, content: interrupt_content.selections };
              break;
            case "query_preview_shape":
              interruptConfig = {
                type: interrupt_content.type,
                content: { status: interrupt_content.status, ...(interrupt_content.shape ?? {}) },
              };
              break;
          }
        }

        const { finalMessage, events, pendingInterrupt } = await streamUserMessage(
          app_id,
          conversationId,
          prompt,
          interruptConfig
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                conversationId,
                finalMessage,
                pendingInterrupt,
                events,
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to run AI builder: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("ToolJet MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});