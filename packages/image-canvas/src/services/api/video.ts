import type { AiConfig } from "@/stores/use-config-store";
import type { UploadedFile } from "@/services/file-storage";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import i18n from "@/i18n";
export type VideoGenerationResult = {blob?: Blob; url?: string; mimeType?: string};
export type VideoGenerationTask = {id: string; provider: "openai"|"gemini"|"plugin"; model: string};
export type VideoGenerationTaskState = {status:"pending"}|{status:"completed";result:VideoGenerationResult}|{status:"failed";error:string};
type Options = {signal?: AbortSignal;videos?:ReferenceVideo[];audios?:ReferenceAudio[]};
export async function requestVideoGeneration(_config: AiConfig,_prompt:string,_refs:ReferenceImage[]=[],_options?:Options):Promise<VideoGenerationResult>{throw new Error(i18n.t("zen.settings"));}
export async function createVideoGenerationTask(_config:AiConfig,_prompt:string,_refs:ReferenceImage[]=[],_options?:Options):Promise<VideoGenerationTask>{throw new Error(i18n.t("zen.settings"));}
export async function pollVideoGenerationTask(_config:AiConfig,_task:VideoGenerationTask,_options?:Options):Promise<VideoGenerationTaskState>{throw new Error(i18n.t("zen.settings"));}
export async function waitForVideoGenerationTask(_config:AiConfig,_task:VideoGenerationTask,_options?:Options):Promise<VideoGenerationResult>{throw new Error(i18n.t("zen.settings"));}
export function isVideoTaskFailed(_error:unknown){return true;}
export async function storeGeneratedVideo(_result:VideoGenerationResult):Promise<UploadedFile>{throw new Error(i18n.t("zen.settings"));}
