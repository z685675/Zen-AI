import type { ImageCanvasBridge, ImageCanvasRequest } from '../../../shared/config/imageCanvas';
import i18n from '@/i18n';
import { inferMediaScale } from '@/lib/media-size';
import { decodeChannelModel, type AiConfig } from '@/stores/use-config-store';
import { imageToDataUrl } from '@/services/image-storage';
import type { ReferenceImage } from '@/types/image';

declare global { interface Window { imageCanvas?: ImageCanvasBridge } }

export function bridge(): ImageCanvasBridge {
    if (!window.imageCanvas) throw new Error(i18n.t('zen.hostRequired'));
    return window.imageCanvas;
}

export function taskErrorText(code?: string) {
    if (/^upstream_http_(?:502|503|504|524)$/.test(code || '')) return i18n.t('zen.gatewayTimeout');
    if (code === 'studio_upgrade_required') return i18n.t('zen.serverUpgrade');
    if (code === 'studio_model_unavailable') return i18n.t('zen.serverModel');
    if (code === 'studio_generation_failed') return i18n.t('zen.serverFailed');
    if (code === 'studio_download_failed') return i18n.t('zen.downloadFailed');
    if (code === 'studio_parameters_unsupported' || code === 'studio_reference_limit' || code === 'gemini_size_unsupported') return i18n.t('zen.parametersUnsupported');
    const status = /^upstream_http_(\d{3})$/.exec(code || '')?.[1];
    return status ? i18n.t('zen.upstreamError', { status }) : i18n.t('zen.uncertain');
}

export async function generate(config: AiConfig, prompt: string, references: ReferenceImage[] = [], signal?: AbortSignal) {
    const selected = decodeChannelModel(config.model || config.imageModel);
    if (!selected) throw new Error(i18n.t('zen.noModels'));
    signal?.throwIfAborted();
    const input: ImageCanvasRequest = {
        id: crypto.randomUUID(), providerId: selected.channelId, modelId: selected.model,
        prompt: [config.systemPrompt, prompt].filter(Boolean).join('\n\n'),
        references: await Promise.all(references.map(image => imageToDataUrl(image))),
        size: config.size || 'auto', quality: config.quality || 'auto', background: config.background || '',
        ...(inferMediaScale(config.size) !== 'auto' ? { resolution: inferMediaScale(config.size).toUpperCase() as '1K' | '2K' | '4K' } : {}),
        count: Math.min(4, Math.max(1, Number(config.count) || 1)),
    };
    signal?.throwIfAborted();
    let task;
    try { task = await bridge().submit(input); }
    catch (error) {
        if (String(error).includes('gemini_size_unsupported')) throw new Error(i18n.t('zen.geminiSize'));
        throw new Error(i18n.t('zen.submitFailed'));
    }
    // Once accepted, cancellation only detaches this UI. The host keeps the task
    // and its results, so reopening the page never silently pays for a retry.
    while (task.status === 'running') {
        signal?.throwIfAborted();
        await new Promise(resolve => setTimeout(resolve, 1000));
        const updated = await bridge().task(task.id);
        if (!updated) throw new Error(i18n.t('zen.uncertain'));
        task = updated;
    }
    signal?.throwIfAborted();
    if (task.status !== 'completed') throw new Error(taskErrorText(task.error));
    return Promise.all(task.assets.map(async id => ({ id, dataUrl: await bridge().asset(id) })));
}
