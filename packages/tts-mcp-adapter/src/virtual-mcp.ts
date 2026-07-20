import type { McpCallOptions, McpCallToolResult, McpClientPort, McpToolDescriptor } from './types.ts';

export interface VirtualMcpCall {
  name: string;
  args: Record<string, unknown>;
}

export type VirtualMcpHandler = (call: VirtualMcpCall, options: McpCallOptions) => McpCallToolResult | Promise<McpCallToolResult>;

export class VirtualMcpClient implements McpClientPort {
  readonly calls: VirtualMcpCall[] = [];
  private tools: McpToolDescriptor[];
  private readonly handler: VirtualMcpHandler;

  constructor(tools: McpToolDescriptor[], handler: VirtualMcpHandler) {
    this.tools = [...tools];
    this.handler = handler;
  }

  setTools(tools: McpToolDescriptor[]): void { this.tools = [...tools]; }
  async listTools(): Promise<McpToolDescriptor[]> { return [...this.tools]; }
  async callTool(name: string, args: Record<string, unknown>, options: McpCallOptions): Promise<McpCallToolResult> {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    const call = { name, args };
    this.calls.push(call);
    return this.handler(call, options);
  }
}
