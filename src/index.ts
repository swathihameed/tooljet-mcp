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

// GET helper for /api/ai/* endpoints, JWT-authed the same way build-app is. The JWT is minted
// per-appId (see getSessionJwt), so even endpoints that aren't conceptually app-scoped
// (taggable-datasources, get-credits-balance) still require an app_id to obtain a token.
async function aiApiGet(appId: string, path: string): Promise<any> {
  const jwt = await getSessionJwt(appId);
  const response = await fetch(`${API_HOST}/api/ai/${path}`, {
    headers: { tj_auth_token: jwt },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

// Maps the artifact name on an interactive-widget response section to the interrupt `type`
// the backend expects back in `interruptConfig.type` when resuming (server/ee/ai/service.ts).
// Widgets that don't set a distinguishing artifact name (phase-plan approval, phase-complete,
// upgrade gate) all resume through the same generic 'approval_response' shape.
const ARTIFACT_NAME_TO_INTERRUPT_TYPE: Record<string, string> = {
  "datasource-selection": "user_ds_selection",
  entity_schema_review: "user_entity_selection",
  "entity-mapping": "user_entity_selection",
  review_module_prd: "spec_doc_user_update",
  "query-preview": "query_preview_shape",
};

// Renders a datasource-selection / approval-style choice as a numbered Markdown menu.
// MCP text content has no real dropdown/checkbox widget, so the closest usable analog is a
// list the caller can pick from and echo the id/label back in the next `interrupt_content`.
function renderSelectionMenu(
  heading: string,
  options: Array<{ label: string; id?: string; suffix?: string; preSelected?: boolean }>,
  instructions: string
): string {
  const lines = [`### ${heading}`, ""];
  options.forEach((opt, i) => {
    const idPart = opt.id ? ` (id: \`${opt.id}\`)` : "";
    const suffixPart = opt.suffix ? ` — ${opt.suffix}` : "";
    const marker = opt.preSelected ? "  ← pre-selected" : "";
    lines.push(`${i + 1}. **${opt.label}**${idPart}${suffixPart}${marker}`);
  });
  lines.push("", instructions);
  return lines.join("\n");
}

// Builds human-readable Markdown for a pending interrupt's artifact content, mirroring how
// the ToolJet UI itself presents each widget type (OutputWidget/InteractiveWidget). Falls back
// to a plain note rather than throwing if the artifact shape doesn't match a known case.
function buildInterruptDisplay(type: string, widget: any, message: any): string {
  const artifact = widget.header?.artifact ?? {};
  const content = artifact.content;

  switch (type) {
    case "user_ds_selection": {
      const optionIds: string[] = artifact.optionDatasourceIds ?? [];
      if (!optionIds.length) {
        return "### Select a datasource\n\nNo pre-filled datasource candidates were provided (this happens when the datasource wasn't @-tagged/mentioned). Use `get-taggable-datasources` to fetch the full candidate list, then reply with the chosen `datasource_id`(s) via `interrupt_content`.";
      }
      const options = optionIds.map((id) => ({
        label: id,
        id,
        suffix: artifact.preFillKind ? `kind: ${artifact.preFillKind}` : undefined,
        preSelected: id === artifact.preSelectedDatasourceId,
      }));
      return renderSelectionMenu(
        "Select a datasource",
        options,
        "Reply with the datasource_id(s) to select via `interrupt_content` (type: user_ds_selection)."
      );
    }

    case "user_entity_selection": {
      const rows: Array<{ entity_name: string; tables: Array<{ name: string; kind: string }> }> =
        artifact.name === "entity_schema_review" ? content?.ui ?? [] : content ?? [];
      if (!Array.isArray(rows) || !rows.length) {
        return "### Entity/table mapping\n\nNo mapping rows found in the artifact.";
      }
      const lines = ["### Entity/table mapping", "", "| Entity | Tables |", "|---|---|"];
      for (const row of rows) {
        const tables = (row.tables ?? []).map((t) => `${t.name} (${t.kind})`).join(", ");
        lines.push(`| ${row.entity_name} | ${tables} |`);
      }
      lines.push("", "Reply with the selected entity/table records via `interrupt_content` (type: user_entity_selection).");
      return lines.join("\n");
    }

    case "spec_doc_user_update": {
      const sections: Array<{ sectionName?: string; content?: string; text?: string }> = Array.isArray(content)
        ? content
        : [];
      if (!sections.length) {
        return "### Specification document\n\nNo document sections found in the artifact.";
      }
      const doc = sections
        .map((s) => `## ${s.sectionName ?? "Section"}\n\n${s.content ?? s.text ?? ""}`)
        .join("\n\n");
      return `${doc}\n\n---\nReply with the edited document via \`interrupt_content\` (type: spec_doc_user_update) to update it, or approve as-is.`;
    }

    case "query_preview_shape": {
      const queryName = content?.query_name ?? "unknown";
      const queryId = content?.query_id ?? "unknown";
      return `### Query preview\n\n- **Query name:** ${queryName}\n- **Query id:** \`${queryId}\`\n\nReply via \`interrupt_content\` (type: query_preview_shape) with \`status: "accepted"\` or \`"declined"\`.`;
    }

    case "approval_response":
    default: {
      const header = widget.header ?? {};
      const responseActions: Array<string | { label: string; isCustom?: boolean }> = widget.responseActions ?? [];
      const primaryCta: Array<{ id: string; label: string }> = widget.primaryCta ?? [];
      const lines = [`### ${header.title ?? "Review needed"}`];
      if (header.subtitle) lines.push("", header.subtitle);
      if (responseActions.length) {
        lines.push("", "Options:");
        responseActions.forEach((opt, i) => {
          const label = typeof opt === "string" ? opt : opt.label;
          lines.push(`${i + 1}. ${label}`);
        });
      }
      if (primaryCta.length) {
        lines.push("", `Actions: ${primaryCta.map((c) => c.label).join(", ")}`);
      }
      if (!responseActions.length && !primaryCta.length && !header.title) {
        return "Structured data available for this interrupt, see raw events for details.";
      }
      lines.push("", "Reply with the chosen label via `interrupt_content` (type: approval_response).");
      return lines.join("\n");
    }
  }
}

// Inspect a single AI message for an interactive-widget section. If present, the conversation
// is paused awaiting a structured answer — surface what's pending (including a human-readable
// `display` rendering of the artifact) so the caller knows what to send on the next call.
function detectPendingInterruptFromMessage(message: any): any {
  const sections = message?.metadata?.sections;
  if (!Array.isArray(sections)) return null;

  const widget = sections.find((s: any) => s?.type === "output-widget-interactive");
  if (!widget) return null;

  const artifactName = widget.header?.artifact?.name;
  const type = (artifactName && ARTIFACT_NAME_TO_INTERRUPT_TYPE[artifactName]) || "approval_response";

  let display: string;
  try {
    display = buildInterruptDisplay(type, widget, message);
  } catch {
    display = "Structured data available for this interrupt, see raw events for details.";
  }

  return {
    type,
    suggestions: message.metadata.resumeSuggestions ?? widget.responseActions ?? [],
    display,
  };
}

// Inspect the last `update_message` event for a pending interrupt. If present, the
// conversation is paused awaiting a structured answer — surface what's pending so the caller
// knows what `interrupt_type`/`interrupt_content` to send on the next `build-app` call.
function detectPendingInterrupt(events: Array<{ type: string; data: any }>): any {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "update_message") continue;

    const pending = detectPendingInterruptFromMessage(event.data);
    if (pending) return pending;
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


// Register get-conversation tool: fetches a conversation's current state, and — since this
// reads the same message data the AI-builder UI reads — reconstructs `pendingInterrupt` the
// same way build-app does. Lets a caller check whether a conversation is paused (e.g. because
// a human already resolved it via the ToolJet UI) before sending a new message.
server.tool(
  "get-conversation",
  "Get a conversation's current state (messages, metadata). Also reports `pendingInterrupt` " +
    "if the conversation is currently paused awaiting a structured answer.",
  {
    app_id: z.string().describe("ID of the app the conversation belongs to. Always ask the user."),
    conversation_id: z.string().describe("ID of the conversation to fetch. Always ask the user."),
  },
  async ({ app_id, conversation_id }) => {
    try {
      const conversation = await aiApiGet(app_id, `conversation/${conversation_id}`);
      const messages = conversation?.aiConversationMessages ?? [];
      const latestMessage = messages[messages.length - 1];
      const pendingInterrupt = latestMessage ? detectPendingInterruptFromMessage(latestMessage) : null;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ conversation, pendingInterrupt }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to get conversation: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Register list-conversations tool.
server.tool(
  "list-conversations",
  "List an app's AI-builder conversations.",
  {
    app_id: z.string().describe("ID of the app to list conversations for. Always ask the user."),
    conversation_type: z
      .string()
      .optional()
      .describe("Conversation type filter, e.g. 'generate'. Defaults to 'generate' if omitted."),
  },
  async ({ app_id, conversation_type }) => {
    try {
      const type = conversation_type ?? "generate";
      const conversations = await aiApiGet(
        app_id,
        `conversations?appId=${encodeURIComponent(app_id)}&conversationType=${encodeURIComponent(type)}`
      );
      return { content: [{ type: "text", text: JSON.stringify(conversations) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to list conversations: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Register get-taggable-datasources tool: gives the caller a real candidate list for
// `user_ds_selection` interrupts when the artifact didn't pre-fill `optionDatasourceIds`
// (i.e. the datasource wasn't @-tagged/mentioned by the user).
server.tool(
  "get-taggable-datasources",
  "Get the datasources the user can reference/select in an AI-builder conversation for this app.",
  {
    app_id: z.string().describe("ID of an app, used only to obtain a session token. Always ask the user."),
  },
  async ({ app_id }) => {
    try {
      const datasources = await aiApiGet(app_id, "taggable-datasources");
      return { content: [{ type: "text", text: JSON.stringify(datasources) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to get taggable datasources: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Register get-credits-balance tool.
server.tool(
  "get-credits-balance",
  "Get the current AI credits balance for the organization.",
  {
    app_id: z.string().describe("ID of an app, used only to obtain a session token. Always ask the user."),
  },
  async ({ app_id }) => {
    try {
      const balance = await aiApiGet(app_id, "get-credits-balance");
      return { content: [{ type: "text", text: JSON.stringify(balance) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to get credits balance: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Register get-thread-token-usage tool.
server.tool(
  "get-thread-token-usage",
  "Get token usage for an AI-builder conversation thread.",
  {
    app_id: z.string().describe("ID of the app the conversation belongs to. Always ask the user."),
    conversation_id: z.string().describe("ID of the conversation to get token usage for. Always ask the user."),
  },
  async ({ app_id, conversation_id }) => {
    try {
      const usage = await aiApiGet(app_id, `conversation/${conversation_id}/token-usage`);
      return { content: [{ type: "text", text: JSON.stringify(usage) }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to get token usage: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
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