import type { AudioSource } from '../../contracts/src/index';

export interface TtsSynthesisRequest {
  text: string;
  voice?: string;
  signal?: AbortSignal;
}

export interface TtsMcpAdapter {
  synthesize(request: TtsSynthesisRequest): Promise<AudioSource>;
}
