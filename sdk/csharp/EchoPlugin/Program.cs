using RstrBot.Plugin;
using System.Text;
using System.Text.Json.Nodes;

await PluginServer.ServeAsync(["tools"], async (method, parameters, call, cancellation) =>
{
    if (method == "tools.list") return JsonNode.Parse("""
        {"tools":[{"name":"echo","effect":"read_only","input_schema":{"type":"object","properties":{"text":{"type":"string","maxLength":16384}},"required":["text"],"additionalProperties":false}}]}
        """);
    if (method != "tools.call"
        || parameters["name"] is not JsonValue name
        || !name.TryGetValue<string>(out var toolName) || toolName != "echo")
        throw new RpcFailure(-32601, "Method not found");
    var arguments = parameters["arguments"] as JsonObject;
    if (arguments?["text"] is not JsonValue value
        || !value.TryGetValue<string>(out var text)
        || text is null || Encoding.UTF8.GetByteCount(text) > 16384)
        throw new RpcFailure(-32602, "Invalid text");
    await call.EmitAsync("tool.progress", new JsonObject { ["stage"] = "received" }, cancellation);
    return new JsonObject
    {
        ["content"] = text,
        ["effect"] = "read_only",
        ["call_id"] = parameters["call_id"]?.DeepClone()
    };
});
