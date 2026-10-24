import type { AiConfig, ModelChannel } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { generate } from "@/embedded/bridge";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import i18n from "@/i18n";
export type AiTextMessage = { role: "system" | "user" | "assistant"; content: string | Array<{type:"text";text:string}|{type:"image_url";image_url:{url:string}}> };
type RequestOptions = { signal?: AbortSignal };
export const requestGeneration = (config: AiConfig, prompt: string, options?: RequestOptions) => generate(config, prompt, [], options?.signal);
export const requestEdit = (config: AiConfig, prompt: string, refs: ReferenceImage[], options?: RequestOptions) => generate(config, buildImageReferencePromptText(prompt, refs), refs, options?.signal);
export async function requestImageQuestion(_config: AiConfig, _messages: AiTextMessage[], _onDelta: (text: string) => void, _options?: RequestOptions): Promise<string> { throw new Error(i18n.t("zen.settings")); }
export async function fetchImageModels(_config: Pick<AiConfig,"baseUrl"|"apiKey"|"apiFormat">): Promise<string[]> { return []; }
export async function fetchChannelModels(channel: ModelChannel): Promise<string[]> { return channel.models.map(model => model.name); }
