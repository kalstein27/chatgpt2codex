import type { LeasePreset } from "../types.js";
import type { LeaseCapability } from "../workspace/lease-guard.js";

interface ToolPreflightRule {
  projectCapability?: LeaseCapability;
  hostManagement?: "admin";
  dynamicReason?: string;
}

export interface CapabilityPreflightPlan {
  advisoryOnly: true;
  complete: boolean;
  plannedTools: string[];
  unknownTools: string[];
  dynamicTools: Array<{ tool: string; reason: string }>;
  project: {
    required: boolean;
    requiredCapabilities: LeaseCapability[];
    recommendedPreset: LeasePreset | null;
    acquireWith: "project_lane_open" | "project_select" | null;
    requiresSeparateAuthorization: boolean;
  };
  hostManagement: {
    requiredLevel: "admin" | null;
    acquireWith: "host_management_acquire" | null;
  };
  nextActions: Array<{
    tool: string;
    purpose: "ensure-host-admin" | "ensure-project-capability" | "execute-planned-tool";
    condition?: string;
    level?: "admin";
    preset?: LeasePreset;
  }>;
}

const RULES: Readonly<Record<string, ToolPreflightRule>> = {
  agent_bootstrap: {},
  connection_status: {},
  agent_guide: {},
  project_rules: {},
  project_status: {},
  repo_status: {},
  workspace_list_projects: {},
  workspace_get_project: {},
  host_management_status: {},
  host_management_acquire: {},
  host_management_release: {},

  code_search: { projectCapability: "read" },
  file_read_slice: { projectCapability: "read" },
  file_read_batch: { projectCapability: "read" },
  command_list: { projectCapability: "read" },
  runtime_update_check: { projectCapability: "read" },

  file_create: { projectCapability: "write" },
  file_apply_patch: { projectCapability: "write" },
  file_edit_lines: { projectCapability: "write" },
  checkpoint_restore: { projectCapability: "write" },
  chatgpt_widget_asset_apply: { projectCapability: "write" },

  save_image_from_path: { projectCapability: "image" },
  save_image_from_url: { projectCapability: "image" },
  save_image_from_clipboard: { projectCapability: "image" },
  save_image_from_download: { projectCapability: "image" },
  retrieve_image_for_vision: { projectCapability: "image" },

  managed_mcp_list: {},
  managed_mcp_status: {},
  managed_mcp_logs: {},
  managed_mcp_tools: {},
  managed_mcp_call: {},
  managed_mcp_resources: {},
  managed_mcp_read_resource: {},

  managed_mcp_check_update: {},
  managed_mcp_install: { hostManagement: "admin" },
  managed_mcp_update: { hostManagement: "admin" },
  managed_mcp_start: { hostManagement: "admin" },
  managed_mcp_restart: { hostManagement: "admin" },
  managed_mcp_stop: { hostManagement: "admin" },
  managed_mcp_remove: { hostManagement: "admin" },
  workspace_refresh_index: { hostManagement: "admin" },
  rg_install_managed: { hostManagement: "admin" },
  mobile_approval_setup: { hostManagement: "admin" },

  command_run: { dynamicReason: "required project capability depends on the selected command policy and intent" },
  command_request: { dynamicReason: "required project capability depends on the requested executable profile and classified risk" },
  e2e_run_command: { dynamicReason: "required project capability depends on writesWorkspace/network/destructive intent" },
  e2e_start_server: { dynamicReason: "required project capability depends on server start intent and network behavior" },
  operation_cancel: { dynamicReason: "requires the exact operation/project authorization and cancellation approval path" },
  runtime_update_prepare: { dynamicReason: "runtime preparation uses a dedicated project/runtime authorization path" },
  runtime_apply_local: { hostManagement: "admin", dynamicReason: "runtime apply uses serial-admin and exact runtime approval rather than an ordinary work lane" },
  macos_app_apply_local: { hostManagement: "admin", dynamicReason: "app replacement uses a dedicated full-write and exact approval path" },
};

function recommendedPreset(capabilities: ReadonlySet<LeaseCapability>): {
  preset: LeasePreset | null;
  requiresSeparateAuthorization: boolean;
} {
  if (capabilities.size === 0) return { preset: null, requiresSeparateAuthorization: false };
  const hasControl = capabilities.has("control");
  const hasNonControl = [...capabilities].some((capability) => capability !== "read" && capability !== "control");
  if (hasControl) {
    return {
      preset: "control",
      requiresSeparateAuthorization: hasNonControl,
    };
  }
  if (capabilities.has("write") || capabilities.has("remote") || (capabilities.has("verify") && capabilities.has("image"))) {
    return { preset: "full-write", requiresSeparateAuthorization: false };
  }
  if (capabilities.has("image")) return { preset: "image-only", requiresSeparateAuthorization: false };
  if (capabilities.has("verify")) return { preset: "tests-only", requiresSeparateAuthorization: false };
  return { preset: "read-only", requiresSeparateAuthorization: false };
}

export function buildCapabilityPreflight(input: {
  plannedTools: readonly string[];
  multiProjectLanesEnabled: boolean;
  selfSourceProject?: boolean;
}): CapabilityPreflightPlan {
  const plannedTools = [...new Set(input.plannedTools.map((tool) => tool.trim()).filter(Boolean))];
  const unknownTools: string[] = [];
  const dynamicTools: Array<{ tool: string; reason: string }> = [];
  const projectCapabilities = new Set<LeaseCapability>();
  let hostAdminRequired = false;

  for (const tool of plannedTools) {
    const rule = RULES[tool];
    if (!rule) {
      unknownTools.push(tool);
      continue;
    }
    if (rule.projectCapability) projectCapabilities.add(rule.projectCapability);
    if (rule.hostManagement === "admin") hostAdminRequired = true;
    if (rule.dynamicReason) dynamicTools.push({ tool, reason: rule.dynamicReason });
  }

  if (
    input.selfSourceProject &&
    [...projectCapabilities].some((capability) => capability !== "read" && capability !== "control")
  ) {
    hostAdminRequired = true;
  }

  const recommendation = recommendedPreset(projectCapabilities);
  const projectRequired = projectCapabilities.size > 0;
  const complete = unknownTools.length === 0 && dynamicTools.length === 0;
  const nextActions: CapabilityPreflightPlan["nextActions"] = [];
  if (hostAdminRequired) {
    nextActions.push({
      tool: "host_management_acquire",
      purpose: "ensure-host-admin",
      level: "admin",
      condition: "skip when this conversation already has a fresh admin grant",
    });
  }
  if (projectRequired && recommendation.preset) {
    nextActions.push({
      tool: input.multiProjectLanesEnabled ? "project_lane_open" : "project_select",
      purpose: "ensure-project-capability",
      preset: recommendation.preset,
      condition: "skip when the caller already holds a fresh same-project capability covering this preset",
    });
  }
  if (complete && plannedTools[0]) {
    nextActions.push({
      tool: plannedTools[0],
      purpose: "execute-planned-tool",
      condition: nextActions.length > 0 ? "after the required authorization steps above are satisfied" : undefined,
    });
  }

  return {
    advisoryOnly: true,
    complete,
    plannedTools,
    unknownTools,
    dynamicTools,
    project: {
      required: projectRequired,
      requiredCapabilities: [...projectCapabilities].sort(),
      recommendedPreset: recommendation.preset,
      acquireWith: projectRequired
        ? input.multiProjectLanesEnabled
          ? "project_lane_open"
          : "project_select"
        : null,
      requiresSeparateAuthorization: recommendation.requiresSeparateAuthorization,
    },
    hostManagement: {
      requiredLevel: hostAdminRequired ? "admin" : null,
      acquireWith: hostAdminRequired ? "host_management_acquire" : null,
    },
    nextActions,
  };
}
