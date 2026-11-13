// Fast Chat 渐进分批加载已由 SillyTavern 原生聊天加载取代(柏宝库 /v1/chats/fast-get 已 410 Retired)。
// 这里保留空入口兼容既有设置面板调用,不再安装常驻 fetch、jQuery.fn.trigger 或全局捕获监听。
function applyFastChatGetOptimization() {
    // Intentionally empty: ST native owns chat loading.
}

export {
    applyFastChatGetOptimization,
};
