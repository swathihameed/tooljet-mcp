# ToolJet MCP

Empower your AI assistants with direct access to your ToolJet platform. This MCP (Model Context Protocol) integration enables AI tools like Claude, Cursor, and other MCP-compatible assistants to interact with your ToolJet instance.

## What is ToolJet MCP?

ToolJet MCP is a bridge that connects AI assistants to your ToolJet platform through the Model Context Protocol. This allows AI tools to:

- Manage users and workspaces
- Access app information
- Perform administrative tasks
- Interact with your ToolJet instance programmatically

## Getting Started

### Requirements

- Node.js (v14 or higher)
- A ToolJet instance with admin access
- An MCP-compatible AI assistant (Claude, Cursor, etc.)

### Configuration

#### Step 1: Get an Access Token

Get an access token of your ToolJet instance that you've setup up in your environment variables. You'll need this token to authenticate the MCP server. Refer to the [ToolJet API](https://docs.tooljet.ai/docs/tooljet-api#enabling-tooljet-api) documentation for more details.

#### Step 2: Set Up Your AI Assistant


Configure your MCP client (such as Claude, Cursor, etc.) to use this server. Most MCP clients store the configuration as JSON in the following format:

```json
{
  "mcpServers": {
    "tooljet": {
      "command": "npx",
      "args": [
        "-y",
        "@tooljet/mcp"
      ],
      "env": {
        "TOOLJET_ACCESS_TOKEN": "your-access-token",
        "TOOLJET_HOST": "https://your-tooljet-instance.com",
        "TOOLJET_USER_EMAIL": "your-tooljet-user-email"
      }
    }
  }
}
```

`TOOLJET_USER_EMAIL` is required for the AI App Builder tools (`build-app` and the 5 tools below it): it identifies which user the AI-builder action is performed as.

### Platform-Specific Setup

#### Windows Users

If you're using Windows, prefix the command with `cmd /c`:

```json
{
  "mcpServers": {
    "tooljet": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "@tooljet/mcp"
      ],
      "env": {
        "TOOLJET_ACCESS_TOKEN": "your-access-token",
        "TOOLJET_HOST": "https://your-tooljet-instance.com"
      }
    }
  }
}
```

## Available Tools

ToolJet MCP provides several tools that AI assistants can use to interact with your ToolJet instance:

### User Management

| Tool | Description |
|------|-------------|
| `get-all-users` | Retrieve a list of all users in your ToolJet instance |
| `get-user` | Get detailed information about a specific user |
| `create-user` | Create a new user in a specified workspace |
| `update-user` | Update a user's profile information |
| `update-user-role` | Change a user's role within a workspace |

### Workspace Management

| Tool | Description |
|------|-------------|
| `get-all-workspaces` | List all workspaces in your ToolJet instance |

### Application Management

| Tool | Description |
|------|-------------|
| `get-all-apps` | List all applications within a specific workspace |

### AI App Builder

| Tool | Description |
|------|-------------|
| `build-app` | Start or continue an AI app-build conversation and send a build/edit instruction to the app builder |
| `get-conversation` | Get a conversation's current state (messages, metadata) and check if it's paused awaiting a structured answer |
| `list-conversations` | List an app's AI-builder conversations |
| `get-taggable-datasources` | Get the datasources you can reference/select in an AI-builder conversation for an app |
| `get-credits-balance` | Get the current AI credits balance for the organization |
| `get-thread-token-usage` | Get token usage for an AI-builder conversation thread |

`build-app` can pause the conversation waiting on a user decision (choose a datasource, approve a
phase plan, review a query preview, etc). When that happens, the tool's response includes a
`pendingInterrupt: { type, suggestions, display }` field — `display` is ready-to-read Markdown
(a selection menu, an entity/table mapping table, or the full spec document, depending on the
type) meant to be shown directly to whoever needs to make the decision. To resume, call
`build-app` again with the same `conversation_id` and an `interrupt_content` object matching
`pendingInterrupt.type`:

| `pendingInterrupt.type` | `interrupt_content` shape | `display` rendering |
|---|---|---|
| `approval_response` | `{ type: "approval_response", label: "Approve & start phase 1" }` | Numbered menu of the available response options |
| `user_ds_selection` | `{ type: "user_ds_selection", selections: [{ datasource_id: "..." }] }` | Numbered menu of candidate datasource IDs (pre-selected one marked). If empty, call `get-taggable-datasources` first to get a real candidate list |
| `user_entity_selection` | `{ type: "user_entity_selection", selections: [{ ... }] }` | Markdown table of entity → table mappings |
| `spec_doc_user_update` | `{ type: "spec_doc_user_update", document: "..." }` | Full specification document, rendered as Markdown with section headers |
| `query_preview_shape` | `{ type: "query_preview_shape", status: "accepted" \| "declined", shape?: {...} }` | Query name/id summary |

`get-conversation` runs the same interrupt-detection logic independently of `build-app` — useful
for checking whether a conversation is still paused (e.g. because someone resolved it directly in
the ToolJet UI instead of through this MCP) before sending another message.

## Example Usage

Once configured, your AI assistant can perform tasks like:

- "Show me all users in my ToolJet instance"
- "Create a new user named John Doe in the Marketing workspace"
- "List all the apps in the Development workspace"
- "Update the role of user@example.com to Admin in the Sales workspace"

## Development

Want to contribute to ToolJet MCP? Here's how to set up the development environment:

```bash
# Clone the repository
git clone https://github.com/ToolJet/tooljet-mcp

# Install dependencies
cd mcp
npm install

# Build the project
npm run build
```

## Learn More

- [ToolJet Documentation](https://docs.tooljet.com/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [ToolJet GitHub Repository](https://github.com/ToolJet/ToolJet)
