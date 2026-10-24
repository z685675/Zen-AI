import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, Navigate, Outlet, RouterProvider } from 'react-router-dom';
import { Alert, Button, Drawer, Empty, App, Image, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import 'antd/dist/reset.css';
import 'streamdown/styles.css';
import '@/styles/globals.css';
import '../../../../src/renderer/src/assets/fonts/harmonyos/harmonyos.css';
import '../../../../src/renderer/src/assets/fonts/ubuntu/ubuntu.css';
import '../../../../src/renderer/src/assets/fonts/country-flag-fonts/flag.css';
import i18n from '@/i18n';
import { AppProviders } from '@/components/layout/app-providers';
import CanvasLibrary from '@/pages/canvas';
import CanvasProject from '@/pages/canvas/project';
import { encodeChannelModel, modelOptionsFromChannels, useConfigStore } from '@/stores/use-config-store';
import { flushCanvasStorage } from '@/stores/canvas/use-canvas-store';
import { bridge, taskErrorText } from './bridge';
import type { ImageCanvasTask } from '../../../shared/config/imageCanvas';

i18n.addResourceBundle('zh-CN', 'translation', { zen: {
    title: '图片画布', history: '生成记录', noModels: '请先在 Zen-AI 服务商设置中启用图片模型。',
    hostRequired: '请在 Zen-AI 中打开图片画布。', submitFailed: '任务未能确认，请查看生成记录后再操作。Gemini 和 Seedream 每次请选择 1 张；最多同时运行 2 个任务。',
    uncertain: '任务状态待确认，请到服务商检查用量后再决定是否重新生成。',
    upstreamError: '服务商未能完成请求（{{status}}），请检查余额、密钥或模型配置。',
    geminiSize: '这个 Gemini 模型不支持所选尺寸，请选择自动分辨率和常见画面比例。',
    gatewayTimeout: '网关超时，客户端未收到图片；服务端可能已完成并计费。请先检查生成记录和服务商用量，勿直接重复生成。',
    serverUpgrade: '服务端尚未提供后台图片任务接口，请先更新 Zen-API 服务端。本次未发送图片生成请求。',
    serverModel: '服务端后台任务尚未开放这个图片模型。本次未发送图片生成请求。',
    serverFailed: '服务端任务未完成，请查看服务端记录和用量后再决定是否重新生成。',
    downloadFailed: '服务端结果未能下载。可检查服务端结果，仅重新读取图片，不再次生成。',
    checkResult: '检查服务端结果',
    parametersUnsupported: '所选参数或参考图数量不受服务端支持，请调整尺寸、画质或数量。本次未发送图片生成请求。',
    taskError: '生成未完成：{{code}}。请查看生成记录及服务商用量，确认后再手动生成。',
    running: '生成中', completed: '已完成', failed: '失败', uncertainStatus: '待确认',
    recover: '插入当前画布', save: '保存图片', preview: '查看图片', empty: '还没有生成记录',
    recoveryHint: '离开页面后任务继续运行。断线或重启后不会自动重新生成；待确认任务请先检查服务商用量。',
    selectCanvas: '请先打开一个画布', inserted: '已插入画布', attribution: '基于 infinite-canvas · MIT',
    settings: '模型与密钥由 Zen-AI 服务商设置统一管理。',
} }, true, true);
i18n.addResourceBundle('en-US', 'translation', { zen: {
    title: 'Image Canvas', history: 'Generation history', noModels: 'Enable image models in Zen-AI provider settings first.',
    hostRequired: 'Open this canvas inside Zen-AI.', submitFailed: 'Task acceptance could not be confirmed. Check history before retrying. Select one image for Gemini/Seedream; at most two tasks can run at once.',
    uncertain: 'Check provider usage before deciding whether to generate again.', taskError: 'Generation incomplete: {{code}}. Check history and provider usage before manually generating again.',
    upstreamError: 'The provider could not complete the request ({{status}}). Check your balance, credentials and model configuration.',
    geminiSize: 'This Gemini model does not support that size. Select automatic resolution and a standard aspect ratio.',
    gatewayTimeout: 'The gateway timed out before the image arrived. The provider may have completed and billed the request. Check history and usage before generating again.',
    serverUpgrade: 'Update Zen-API to enable background image jobs. No image generation request was sent.',
    serverModel: 'This model is unavailable in server background jobs. No generation request was sent.',
    serverFailed: 'The server job did not complete. Check server history and usage before generating again.',
    downloadFailed: 'The server result could not be downloaded. Check the server result to retrieve it without generating again.',
    checkResult: 'Check server result',
    parametersUnsupported: 'The server does not support the selected parameters or reference count. Adjust size, quality or count. No generation request was sent.',
    running: 'Running', completed: 'Completed', failed: 'Failed', uncertainStatus: 'Uncertain',
    recover: 'Insert into canvas', save: 'Save image', preview: 'View images', empty: 'No generations yet',
    recoveryHint: 'Tasks continue when you leave the page. Disconnections and restarts never automatically resend a generation. Check provider usage for uncertain tasks.',
    selectCanvas: 'Open a canvas first', inserted: 'Inserted into canvas', attribution: 'Based on infinite-canvas · MIT',
    settings: 'Models and credentials are managed in Zen-AI provider settings.',
} }, true, true);
i18n.addResource('zh-CN', 'translation', 'canvas.promptPanel.stop', '停止等待');
i18n.addResource('en-US', 'translation', 'canvas.promptPanel.stop', 'Stop waiting');
i18n.addResource('zh-CN', 'translation', 'canvas.configNode.stop', '停止等待');
i18n.addResource('en-US', 'translation', 'canvas.configNode.stop', 'Stop waiting');
i18n.addResource('zh-CN', 'translation', 'canvas.node.retry', '重新生成');
i18n.addResource('en-US', 'translation', 'canvas.node.retry', 'Generate again');
i18n.addResource('zh-CN', 'translation', 'canvas.nodeToolbar.retryTitle', '提交新生成任务，可能再次计费');
i18n.addResource('en-US', 'translation', 'canvas.nodeToolbar.retryTitle', 'Submit a new generation; additional charges may apply');

function Shell() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [historyOpen, setHistoryOpen] = useState(false);
    const [tasks, setTasks] = useState<ImageCanvasTask[]>([]);
    const [previews, setPreviews] = useState<Record<string, string[]>>({});
    const [hostReady, setHostReady] = useState(false);
    const [noModels, setNoModels] = useState(false);
    useEffect(() => {
        let disposed = false;
        async function sync() {
            try {
                const catalog = await bridge().catalog();
                if (disposed) return;
                const channels = catalog.map(provider => ({
                    id: provider.id, name: provider.name, baseUrl: '', apiKey: '', apiFormat: 'openai' as const, hostProtocol: provider.models[0]?.protocol,
                    models: provider.models.map(model => ({ name: model.id, capability: 'image' as const, hostProtocol: model.protocol })),
                }));
                const models = modelOptionsFromChannels(channels);
                const current = useConfigStore.getState().config;
                const imageModel = models.includes(current.imageModel) ? current.imageModel : models[0] || '';
                if (JSON.stringify(current.channels) !== JSON.stringify(channels)) {
                    useConfigStore.setState({ config: { ...current, channels, models, model: imageModel, imageModel,
                        // Native APIs have no common n parameter. Keep the first-run preference at one.
                        count: '1', canvasImageCount: '1', baseUrl: '', apiKey: '', proxyEnabled: false } });
                }
                setNoModels(!models.length);
                setHostReady(true);
            } catch { if (!disposed) setHostReady(false); }
        }
        void sync();
        const timer = setInterval(() => void sync(), 3000);
        const unflush = window.imageCanvas?.flush(async () => { window.dispatchEvent(new Event("zen-canvas-flush")); await flushCanvasStorage(); });
        return () => { disposed = true; clearInterval(timer); unflush?.(); };
    }, []);
    useEffect(() => {
        if (!historyOpen || !hostReady) return;
        let disposed = false;
        const sync = () => bridge().history().then(records => { if (!disposed) setTasks(records); }).catch(() => undefined);
        void sync();
        const timer = setInterval(sync, 1500);
        return () => { disposed = true; clearInterval(timer); };
    }, [historyOpen, hostReady]);
    return <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', overflow: 'hidden' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '8px 18px', borderBottom: '1px solid #8883', flexShrink: 0 }}>
            <strong>Zen-AI · {t('zen.title')}</strong>
            <span style={{ flex: 1, fontSize: 12, opacity: .55 }} title={t('zen.settings')}>{t('zen.attribution')}</span>
            <Button size="small" onClick={() => setHistoryOpen(true)}>{t('zen.history')}</Button>
        </header>
        {(!hostReady || noModels) && <Alert type="info" title={t(hostReady ? 'zen.noModels' : 'zen.hostRequired')} showIcon />}
        <main style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}><Outlet /></main>
        <Drawer title={t('zen.history')} open={historyOpen} onClose={() => setHistoryOpen(false)} size={520}>
            <Alert type="info" title={t('zen.recoveryHint')} style={{ marginBottom: 16 }} />
            {!tasks.length && <Empty description={t('zen.empty')} />}
            {tasks.slice(0, 100).map(task => <article key={task.id} style={{ borderBottom: '1px solid #8883', padding: '16px 0' }}>
                <Tag color={task.status === 'completed' ? 'green' : task.status === 'running' ? 'blue' : 'orange'}>{t(`zen.${task.status === 'uncertain' ? 'uncertainStatus' : task.status}`)}</Tag>
                <small>{task.modelId} · {new Date(task.createdAt).toLocaleString()}</small>
                <p style={{ whiteSpace: 'pre-wrap' }}>{task.prompt.slice(0, 500)}</p>
                {task.error && <p>{taskErrorText(task.error)}</p>}
                {task.status === 'uncertain' && task.recoverable && <Button size="small" onClick={async () => {
                    try { await bridge().recover(task.id); setTasks(await bridge().history()); }
                    catch { message.error(t('zen.uncertain')); }
                }}>{t('zen.checkResult')}</Button>}
                {task.assets.length > 0 && !previews[task.id] && <Button size="small" onClick={async () => {
                    try { const images = await Promise.all(task.assets.map(id => bridge().asset(id))); setPreviews(prev => ({ ...prev, [task.id]: images })); }
                    catch { message.error(t('zen.uncertain')); }
                }}>{t('zen.preview')}</Button>}
                {previews[task.id]?.map((url, index) => <div key={task.assets[index]} style={{ marginTop: 12 }}>
                    <Image src={url} width={180} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <Button size="small" onClick={() => {
                            if (!/^#\/canvas\/[^/?]+/.test(location.hash)) { message.info(t('zen.selectCanvas')); return; }
                            window.dispatchEvent(new CustomEvent('zen-insert-image', { detail: { kind: 'image', dataUrl: url, title: task.prompt.slice(0, 60) } }));
                            setHistoryOpen(false);
                        }}>{t('zen.recover')}</Button>
                        <Button size="small" onClick={() => { const a = document.createElement('a'); a.href = url; a.download = `${task.assets[index]}.png`; a.click(); }}>{t('zen.save')}</Button>
                    </div>
                </div>)}
            </article>)}
        </Drawer>
    </div>;
}

const appearance = new URLSearchParams(location.hash.slice(1));
document.body.setAttribute('os', appearance.get('os') || '');
const fontFamily = appearance.get('fontFamily');
if (fontFamily) document.documentElement.style.setProperty('--user-font-family', JSON.stringify(fontFamily));

const router = createHashRouter([{ element: <Shell />, children: [
    { path: '/canvas', element: <CanvasLibrary /> },
    { path: '/canvas/:id', element: <CanvasProject /> },
    { path: '*', element: <Navigate to="/canvas" replace /> },
] }]);
createRoot(document.getElementById('root')!).render(<React.StrictMode><AppProviders><RouterProvider router={router} /></AppProviders></React.StrictMode>);
