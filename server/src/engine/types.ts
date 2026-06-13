import type { AuthStatus } from '@imagegen/shared';

export interface EngineResult {
  /** エンジンが所有する一時ファイルへの絶対パス(呼び出し側が move する) */
  pngPath: string;
  revisedPrompt?: string;
}

export interface ImageEngine {
  start(): Promise<void>;
  generate(req: { prompt: string }): Promise<EngineResult>;
  edit(req: { prompt: string; refImagePaths: string[] }): Promise<EngineResult>;
  authStatus(): Promise<AuthStatus>;
  stop(): Promise<void>;
}
