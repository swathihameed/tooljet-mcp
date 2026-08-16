#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_HOST = `${process.env.TOOLJET_HOST}`;
const AI_EXT_BASE = `${API_HOST}/api/ext/ai`;

// SSE reads (and, loosely, the overall build-app call) get aborted if no data arrives for this
// long, so a stalled agent pipeline can't hang the tool call forever.
const SSE_IDLE_TIMEOUT_MS = 120_000;

// All AI-flow calls go through the same /api/ext/* Basic-auth protocol the other 6 tools
// already use — no more per-app JWT minting. Interim: the acting user is still identified by
// TOOLJET_USER_EMAIL on every request (same impersonation-capable pattern as before, just one
// less hop); a per-user token will replace this once the auth rework lands (see
// .claude/tj_plans/tj_mcp_ai_flow.md).
function extAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Basic ${process.env.TOOLJET_ACCESS_TOKEN}`,
    ...extra,
  };
}

// GET helper for /api/ext/ai/* endpoints.
async function aiApiGet(path: string, params: Record<string, string | undefined>): Promise<any> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  const url = `${AI_EXT_BASE}/${path}?${query.toString()}`;
  const response = await fetch(url, { headers: extAuthHeaders() });
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

// Create (or continue) an AI-builder conversation for an app.
async function createConversation(
  appId: string,
  conversationType: string,
  currentConversationId?: string
): Promise<{ id: string; [key: string]: any }> {
  const response = await fetch(`${AI_EXT_BASE}/conversation`, {
    method: "POST",
    headers: extAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      email: process.env.TOOLJET_USER_EMAIL,
      appId,
      conversationType,
      currentConversationId,
    }),
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
  const response = await fetch(`${AI_EXT_BASE}/conversation/message`, {
    method: "POST",
    headers: extAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      email: process.env.TOOLJET_USER_EMAIL,
      appId,
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

  try {
    while (true) {
      // Race each read against an idle timeout so a stalled pipeline (agent hung, connection
      // dropped without closing) can't block the tool call forever. Heartbeat frames from the
      // backend (every 5s under normal operation) keep resetting this, so it only fires on a
      // genuine stall.
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`SSE stream idle for over ${SSE_IDLE_TIMEOUT_MS / 1000}s, aborting.`)),
          SSE_IDLE_TIMEOUT_MS
        );
      });

      let done: boolean, value: Uint8Array | undefined;
      try {
        ({ done, value } = await Promise.race([reader.read(), timeout]));
      } finally {
        clearTimeout(timeoutHandle!);
      }

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
  } catch (error) {
    // Surface whatever we already collected instead of losing it, but make sure the caller
    // knows the stream didn't complete normally.
    await reader.cancel().catch(() => {});
    events.push({ type: "stream_error", data: { message: error instanceof Error ? error.message : String(error) } });
  }

  const pendingInterrupt = detectPendingInterrupt(events);
  // The backend only ever emits a `finalMessage` SSE event for a narrow set of cases — most
  // successful builds (and the insufficient-credits / archived-conversation error paths) end
  // the stream after an `update_message`/`message` event with no `finalMessage` at all. Without
  // a pending interrupt to explain the silence, derive a result from the last substantive
  // message instead of returning a bare `null` that looks identical for success and failure.
  if (!finalMessage && !pendingInterrupt) {
    finalMessage = deriveFinalMessage(events);
  }

  return { finalMessage, events, pendingInterrupt };
}

// Fallback for when the backend ends the SSE stream without an explicit `finalMessage` event.
// Walks events backwards looking for the last non-interactive AI message with real content,
// and flags it as an error if it matches the known insufficient-credits/archived-conversation
// shapes (see ToolJet/server/ee/ai/service.ts sendUserMessage's early-return error paths).
function deriveFinalMessage(events: Array<{ type: string; data: any }>): { content: string; isError: boolean } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "stream_error") {
      return { content: event.data.message, isError: true };
    }
    if (event.type !== "update_message" && event.type !== "message") continue;

    const metadata = event.data?.metadata;
    const sections = metadata?.sections;
    if (Array.isArray(sections) && sections.length) {
      if (sections.some((s: any) => s?.type === "output-widget-interactive")) continue; // handled via pendingInterrupt

      // section.content is usually a plain string (markdown sections), but the non-markdown
      // shape used by generateErrorMessageForUser wraps it one level deeper as
      // [{..., content: theActualString}] — unwrap both shapes rather than stringifying the
      // array via join() (which previously produced literal "[object Object]").
      const sectionText = sections
        .filter((s: any) => !s.ephemeral)
        .map((s: any) => {
          if (typeof s.content === "string") return s.content;
          if (Array.isArray(s.content)) {
            return s.content
              .map((c: any) => (typeof c === "string" ? c : c?.content))
              .filter((c: any) => typeof c === "string")
              .join("\n");
          }
          return null;
        })
        .filter(Boolean)
        .join("\n\n");

      const isError = Boolean(metadata.creditsError || metadata.action_button_type === "credits-error");
      // The plain top-level `content` field (set directly by e.g. generateErrorMessageForUser)
      // is the authoritative text for error messages — prefer it over the derived section text.
      const content = isError && typeof event.data?.content === "string" && event.data.content.trim()
        ? event.data.content
        : sectionText;

      if (content) {
        return { content, isError };
      }
    }

    if (typeof event.data?.content === "string" && event.data.content.trim() && event.data.messageType === "ai") {
      return { content: event.data.content, isError: false };
    }
  }
  return null;
}

// Extracts the readable text out of a message/update_message event's sections, mirroring the
// section-unwrapping logic in deriveFinalMessage (kept separate since this is used for every
// message event in the stream, not just the final one).
function extractMessageText(data: any): string | undefined {
  if (typeof data?.content === "string" && data.content.trim()) return data.content;
  const sections = data?.metadata?.sections;
  if (!Array.isArray(sections)) return undefined;
  const text = sections
    .filter((s: any) => !s.ephemeral && s.type !== "output-widget-interactive")
    .map((s: any) => (typeof s.content === "string" ? s.content : null))
    .filter(Boolean)
    .join("\n\n");
  return text || undefined;
}

function countCreateUpdateDelete(bucket: any): { created: number; updated: number; deleted: number } | null {
  if (!bucket) return null;
  const created = bucket.create?.length ?? 0;
  const updated = bucket.update?.length ?? 0;
  const deleted = bucket.delete?.length ?? 0;
  if (!created && !updated && !deleted) return null;
  return { created, updated, deleted };
}

// A `diff` event's payload is shaped for the frontend's React state reducer (full component
// styles/layout/handlers) — nothing an LLM caller needs to read. Reduce it to counts of what
// changed per resource type instead.
function summarizeDiff(eventData: any): Record<string, { created: number; updated: number; deleted: number }> {
  const data = eventData?.data ?? eventData;
  const summary: Record<string, { created: number; updated: number; deleted: number }> = {};

  for (const key of ["events", "queries", "pages", "folders"]) {
    const counts = countCreateUpdateDelete(data?.[key]);
    if (counts) summary[key] = counts;
  }

  // Components are nested inside each touched page's own `components` field, not top-level.
  const components = { created: 0, updated: 0, deleted: 0 };
  const touchedPages = [...(data?.pages?.create ?? []), ...(data?.pages?.update ?? [])];
  for (const page of touchedPages) {
    const counts = countCreateUpdateDelete(page?.components);
    if (counts) {
      components.created += counts.created;
      components.updated += counts.updated;
      components.deleted += counts.deleted;
    }
  }
  if (components.created || components.updated || components.deleted) summary.components = components;

  return summary;
}

// Reduces one SSE event to what an LLM caller actually needs — the backend's payload is shaped
// for the frontend's own state reducer, not for reading. `finalMessage`/`pendingInterrupt.display`
// already carry the important summary; this just makes the accompanying `events` list lightweight
// instead of repeating the same information as a full React-diff payload.
function summarizeEvent(event: { type: string; data: any }): { type: string; [key: string]: any } {
  switch (event.type) {
    case "message":
    case "update_message": {
      const text = extractMessageText(event.data);
      return text ? { type: event.type, text } : { type: event.type };
    }
    case "diff":
      return { type: "diff", changed: summarizeDiff(event.data) };
    case "preview":
      return { type: "preview", preview: event.data?.preview };
    case "stream_error":
      return { type: "stream_error", message: event.data?.message };
    default:
      return { type: event.type };
  }
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
    conversation_id: z.string().describe("ID of the conversation to fetch. Always ask the user."),
  },
  async ({ conversation_id }) => {
    try {
      const conversation = await aiApiGet(`conversation/${conversation_id}`, {
        email: process.env.TOOLJET_USER_EMAIL,
      });
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
        isError: true,
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
      const conversations = await aiApiGet("conversations", {
        email: process.env.TOOLJET_USER_EMAIL,
        appId: app_id,
        conversationType: conversation_type ?? "generate",
      });
      return { content: [{ type: "text", text: JSON.stringify(conversations) }] };
    } catch (error) {
      return {
        isError: true,
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
    app_id: z.string().describe("ID of an app, used to resolve the organization's datasources. Always ask the user."),
  },
  async ({ app_id }) => {
    try {
      const datasources = await aiApiGet("taggable-datasources", {
        email: process.env.TOOLJET_USER_EMAIL,
        appId: app_id,
      });
      return { content: [{ type: "text", text: JSON.stringify(datasources) }] };
    } catch (error) {
      return {
        isError: true,
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
    app_id: z.string().describe("ID of an app, used to resolve the organization's credits balance. Always ask the user."),
  },
  async ({ app_id }) => {
    try {
      const balance = await aiApiGet("get-credits-balance", {
        email: process.env.TOOLJET_USER_EMAIL,
        appId: app_id,
      });
      return { content: [{ type: "text", text: JSON.stringify(balance) }] };
    } catch (error) {
      return {
        isError: true,
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
    conversation_id: z.string().describe("ID of the conversation to get token usage for. Always ask the user."),
  },
  async ({ conversation_id }) => {
    try {
      const usage = await aiApiGet(`conversation/${conversation_id}/token-usage`, {
        email: process.env.TOOLJET_USER_EMAIL,
      });
      return { content: [{ type: "text", text: JSON.stringify(usage) }] };
    } catch (error) {
      return {
        isError: true,
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
      include_raw_events: z
        .boolean()
        .optional()
        .describe(
          "Include the full, unfiltered SSE event stream (component/query/page definitions as sent to the frontend) instead of a lightweight summary. Only needed for debugging — omit for normal use."
        ),
    },
    async ({ app_id, prompt, conversation_id, interrupt_content, include_raw_events }) => {
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
          isError: Boolean(finalMessage?.isError),
          content: [
            {
              type: "text",
              text: JSON.stringify({
                conversationId,
                finalMessage,
                pendingInterrupt,
                events: include_raw_events ? events : events.map(summarizeEvent),
              }),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
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