// Agent and UI share the exact same preview/apply/status/retire service.
// Deliberately excludes login, logout and authorization confirmations.
export function registerModelTool(ctx, service) {
  return ctx.tools.register({
    name: "copilot_models",
    description: "Preview and manage GitHub Copilot models. Preview defaults to supplementing latest account-available models without deleting models or customizations. Apply requires IDs returned by that preview. Does not grant account access or sign in.",
    parameters: {
      type: "object", additionalProperties: false, required: ["action"],
      properties: {
        action: { type: "string", enum: ["preview", "preview-manual", "apply", "status", "retire"] },
        catalogSource: { type: "string", enum: ["latest", "local", "overlay"] },
        previewId: { type: "string" }, operationId: { type: "string" },
        selectedIds: { type: "array", items: { type: "string" }, description: "Used only by preview-manual. The default preview always supplements without removals, including when this array is empty." },
      },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, result) => [{ type: "text", text: JSON.stringify(result) }],
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted();
      if (!args || !["preview", "preview-manual", "apply", "status", "retire"].includes(args.action)) throw new Error("invalid-action");
      if (["apply", "retire"].includes(args.action) && typeof args.operationId !== "string") throw new Error("operationId required");
      if (args.action === "apply" && typeof args.previewId !== "string") throw new Error("previewId required");
      let result;
      if (args.action === "preview" || args.action === "preview-manual") {
        if (args.action === "preview-manual" && !Array.isArray(args.selectedIds)) throw new Error("selectedIds required");
        result = await service.preview({
          operation: "manage", catalogSource: args.catalogSource || "latest",
          ...(args.action === "preview" ? { selectionMode: "supplement" } : { selectedIds: args.selectedIds }),
        });
      } else if (args.action === "apply") {
        result = await service.apply({ previewId: args.previewId, operationId: args.operationId });
      } else if (args.action === "retire") {
        result = await service.retire({ operationId: args.operationId });
      } else {
        result = await service.status({ operationId: args.operationId });
      }
      // All owned I/O has settled before cancellation is reported; transactions
      // are not interrupted halfway through configuration persistence.
      exec?.signal?.throwIfAborted();
      return result;
    },
  });
}
