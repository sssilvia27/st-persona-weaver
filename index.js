// ============================================================================
// 初始化
// ============================================================================

jQuery(async () => {
    injectStyles();
    
    // [已删除] 原来的 extensions_settings2 注入代码
    // [新增] 注入到用户人设面板的按钮栏 (#user_persona_buttons 是 ST 存放那些小图标的容器 ID)
    
    const injectButton = () => {
        // 防止重复注入
        if ($('#pw-quick-btn').length) return;

        // 创建按钮 HTML
        const $btn = $(`
            <div id="pw-quick-btn" title="设定编织者 Pro: 生成/优化当前人设">
                <i class="fa-solid fa-wand-magic-sparkles" style="color:#e0af68;"></i>
            </div>
        `);

        // 绑定点击事件
        $btn.on("click", openCreatorPopup);

        // 插入到 ST 的人设按钮容器中
        // #user_persona_buttons 是包含 编辑、刷新、地球仪 等图标的父容器
        const $targetContainer = $('#user_persona_buttons');
        
        if ($targetContainer.length) {
            $targetContainer.append($btn);
        } else {
            console.warn("[PW] 找不到 #user_persona_buttons 容器，尝试延迟注入...");
            setTimeout(injectButton, 1000); // 简单的重试机制
        }
    };

    // 立即尝试注入
    injectButton();

    // 监听 ST 可能的重绘（保险起见，如果使用了某些重置界面的操作）
    const observer = new MutationObserver((mutations) => {
        if (!$('#pw-quick-btn').length && $('#user_persona_buttons').length) {
            injectButton();
        }
    });
    
    // 监听整个 body 或者特定父容器的变化
    observer.observe(document.body, { childList: true, subtree: true });

    console.log(`${extensionName} v18 loaded (Button injected).`);
});
