import { serve, RpcFailure } from '../dist/index.js';

await serve(['tools'], async (method, params, call) => {
  if (method === 'tools.list') return { tools: [{ name: 'echo', effect: 'read_only', input_schema: {
    type: 'object', properties: { text: { type: 'string', maxLength: 16384 } }, required: ['text'], additionalProperties: false
  } }] };
  if (method !== 'tools.call' || params.name !== 'echo') throw new RpcFailure(-32601, 'Method not found');
  const text = params.arguments?.text;
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16384) throw new RpcFailure(-32602, 'Invalid text');
  await call.emit('tool.progress', { stage: 'received' });
  return { content: text, effect: 'read_only', call_id: params.call_id };
});
