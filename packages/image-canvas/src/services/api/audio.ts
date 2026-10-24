import type { AiConfig } from "@/stores/use-config-store";
import type { UploadedFile } from "@/services/file-storage";
import i18n from "@/i18n";
export async function requestAudioGeneration(_config:AiConfig,_prompt:string,_options?:{signal?:AbortSignal}):Promise<Blob>{throw new Error(i18n.t("zen.settings"));}
export async function storeGeneratedAudio(_blob:Blob,_format="mp3"):Promise<UploadedFile>{throw new Error(i18n.t("zen.settings"));}
