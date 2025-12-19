import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, callPopup, getRequestHeaders } from "../../../../script.js";

// ============================================================================
// 1. 常量与配置
// ============================================================================
const extensionName = "st-persona-weaver";
// 升级 key 版本以确保旧缓存不干扰新逻辑
const STORAGE_KEY_HISTORY = 'pw_history_v21';
const STORAGE_KEY_STATE = 'pw_state_v21'; 
const STORAGE_KEY_TAGS = 'pw_tags_v21';
const BUTTON_ID = 'pw_persona_tool_btn';

const defaultTags = [
    { name: "性别", value: "" }, { name: "年龄", value: "" }, { name: "MBTI", value: "" },
    { name: "职业", value: "" }, { name: "阵营", value: "" }, { name: "外貌", value: "" },
    { name: "性格", value: "" }, { name: "关系", value: "" }, { name: "XP", value: "" },
    { name: "秘密", value: "" }
];

const defaultSettings = {
    historyLimit: 50,
    apiSource: 'main', 
    indepApiUrl: 'https://api.openai.com/v1',
    indepApiKey: '',
    indepApiModel: 'gpt-3.5-turbo'
};

const TEXT = {
    PANEL_TITLE: "用户设定编织者 Pro",
    BTN_TITLE: "打开设定生成器",
    TOAST_API_OK: "API 连接成功",
    TOAST_API_ERR: "API 连接失败",
    TOAST_SAVE_API: "API 设置已保存",
    TOAST_SNAPSHOT: "已存入历史记录",
    TOAST_GEN_FAIL: "生成失败，请检查 API 设置",
    TOAST_SAVE_SUCCESS: (name) => `Persona "${name}" 已更新！`,
    TOAST_WI_SUCCESS: (book) => `已写入世界书: ${book}`,
    TOAST_WI_FAIL: "未找到有效的世界书，无法同步保存"
};

let historyCache = [];
let tagsCache = [];
let worldInfoCache = {}; 
let availableWorldBooks = []; 
let isEditingTags = false; 

// ============================================================================
// 2. 数据存储与状态管理
// ============================================================================
function loadData() {
    try { historyCache = JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY)) || []; } catch { historyCache = []; }
    try { tagsCache = JSON.parse(localStorage.getItem(STORAGE_KEY_TAGS)) || defaultTags; } catch { tagsCache = defaultTags; }
}

function saveData() {
    localStorage.setItem(STORAGE_KEY_TAGS, JSON.stringify(tagsCache));
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(historyCache));
}

function saveHistory(item) {
    const limit = extension_settings[extensionName]?.historyLimit || 50;
    historyCache.unshift(item);
    if (historyCache.length > limit) historyCache = historyCache.slice(0, limit);
    saveData();
}

// 保存当前 UI 状态 (用于刷新或返回上级页面时恢复)
function saveState(data) {
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(data));
}

function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_STATE)) || {}; } catch { return {}; }
}

function injectStyles() {
    // 样式由 style.css 处理，此处保留函数以防未来需要动态注入
}

// 捕获当前 UI 状态并保存到 LocalStorage
const captureCurrentState = () => {
    saveState({
        request: $('#pw-request').val(),
        resultText: $('#pw-result-text').val(),
        // 如果结果区可见，保存状态以便恢复
        hasResult: $('#pw-result-area').is(':visible'), 
        // 记录当前激活的 Tab
        activeTab: $('.pw-tab.active').data('tab') || 'editor',
        localConfig: {
            apiSource: $('#pw-api-source').val(),
            indepApiUrl: $('#pw-api-url').val(),
            indepApiKey: $('#pw-api-key').val(),
            indepApiModel: $('#pw-api-model').val(),
            extraBooks: window.pwExtraBooks || []
        }
    });
};

// ============================================================================
// 3. 核心业务逻辑
// ============================================================================

// [核心] 暴力写入 Persona 设置
async function forceSavePersona(name, description) {
    const context = getContext();
    if (!context.powerUserSettings.personas) context.powerUserSettings.personas = {};
    context.powerUserSettings.personas[name] = description;
    context.powerUserSettings.persona_selected = name;
    
    // UI 更新：尝试同步更新酒馆原本的设置面板
    const $nameInput = $('#your_name');
    const $descInput = $('#persona_description');
    if ($nameInput.length) $nameInput.val(name).trigger('input').trigger('change');
    if ($descInput.length) $descInput.val(description).trigger('input').trigger('change');
    
    // 更新左侧栏名字显示
    const $h5Name = $('h5#your_name');
    if ($h5Name.length) $h5Name.text(name);
    
    await saveSettingsDebounced();
    console.log(`[PW] Persona "${name}" updated.`);
    return true;
}

// [增强] 获取所有可用的世界书列表 (修复列表为空的问题)
async function loadAvailableWorldBooks() {
    availableWorldBooks = [];
    try {
        const context = getContext();
        
        // 1. 尝试从 context 直接获取
        if (context.worldInfoFiles) {
            availableWorldBooks = [...context.worldInfoFiles];
        }
        
        // 2. 尝试通过 API 获取 (兼容不同后端版本)
        const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}) });
        if (response.ok) {
            const data = await response.json();
            let apiBooks = [];
            
            // 兼容性处理：有的版本返回数组，有的返回对象包含 world_names
            if (Array.isArray(data)) {
                apiBooks = data.map(item => (typeof item === 'string' ? item : item.name));
            } else if (data && Array.isArray(data.world_names)) {
                apiBooks = data.world_names;
            } else if (data && Array.isArray(data.entries)) {
                // 极端情况 fallback
            }
            
            availableWorldBooks = [...new Set([...availableWorldBooks, ...apiBooks])];
        }
    } catch (e) { console.error("[PW] Worldbook list load failed", e); }
    
    // 去重、过滤空值、排序
    availableWorldBooks = [...new Set(availableWorldBooks)].filter(x => x).sort();
}

// 获取当前上下文（角色/聊天）绑定的世界书
async function getContextWorldBooks(extras = []) {
    const context = getContext();
    const books = new Set(extras); 
    const charId = context.characterId;
    
    // 1. 聊天绑定的世界书
    if (context.chatMetadata?.world_info) books.add(context.chatMetadata.world_info);

    // 2. 角色绑定的世界书 (如果有角色)
    if (charId !== undefined && context.characters && context.characters[charId]) {
        const char = context.characters[charId];
        const data = char.data || char;
        if (data.character_book?.name) books.add(data.character_book.name);
        if (data.extensions?.world) books.add(data.extensions.world);
        if (data.world) books.add(data.world);
    }
    return Array.from(books).filter(Boolean);
}

// 获取指定世界书的条目
async function getWorldBookEntries(bookName) {
    if (worldInfoCache[bookName]) return worldInfoCache[bookName];
    try {
        const headers = getRequestHeaders();
        const response = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name: bookName }) });
        if (response.ok) {
            const data = await response.json();
            const entries = Object.values(data.entries || {}).map(e => ({
                uid: e.uid,
                displayName: e.comment || (Array.isArray(e.key) ? e.key.join(', ') : e.key),
                content: e.content,
                enabled: !e.disable && e.enabled !== false
            }));
            worldInfoCache[bookName] = entries;
            return entries;
        }
    } catch {}
    return [];
}

// [逻辑优化] 生成与润色逻辑 (支持无角色模式)
async function runGeneration(data, apiConfig) {
    const context = getContext();
    
    // 获取角色信息，如果没有则使用通用模板
    let charName = "Generic Character";
    let charScenario = "General Chat";
    
    if (context.characters && context.characterId !== undefined) {
        const char = context.characters[context.characterId];
        if (char) {
            charName = char.name;
            charScenario = char.scenario || "";
        }
    }
    
    const currentName = $('h5#your_name').text().trim() || context.powerUserSettings?.persona_selected || "User";
    
    let wiText = "";
    if (data.wiContext && data.wiContext.length > 0) {
        wiText = `\n[Context from World Info]:\n${data.wiContext.join('\n\n')}\n`;
    }
    
    let systemPrompt = "";
    
    if (data.mode === 'refine') {
        // === 润色模式 Prompt ===
        systemPrompt = `You are a creative writing assistant optimizing a User Persona.
Target Character: ${charName}
Scenario: ${charScenario}
${wiText}
[Current Persona Data]:
"""
${data.currentText}
"""
[Refinement Instruction]:
"${data.request}"
[Task]:
1. Modify the Persona Data according to the instruction.
2. If the user provided a specific text segment, focus on modifying that part.
3. Maintain the "Key: Value" list format.
4. User Name: "${currentName}" (Immutable).
[Response Format]:
Return ONLY the Key-Value list text. No Markdown blocks.
`;
    } else {
        // === 初始生成模式 Prompt ===
        const targetKeys = tagsCache.map(t => t.name).filter(n => n).join(', ');
        systemPrompt = `You are a creative writing assistant creating a User Persona.
Target Character: ${charName}
Scenario: ${charScenario}
${wiText}
[User Request]:
${data.request}
[Task]:
1. Create a detailed Persona for "${currentName}".
2. Use "Key: Value" format for traits (one per line).
3. Recommended Keys: ${targetKeys}.
[Response Format]:
Return ONLY the Key-Value list text.
Example:
Gender: Female
Age: 20
Personality: ...
`;
    }

    let responseContent = "";
    // API 调用逻辑
    if (apiConfig.apiSource === 'independent') {
        const url = `${apiConfig.indepApiUrl.replace(/\/$/, '')}/chat/completions`;
        const body = {
            model: apiConfig.indepApiModel,
            messages: [{ role: 'system', content: systemPrompt }],
            temperature: 0.7
        };
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.indepApiKey}` },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error("Independent API Error: " + res.statusText);
        const json = await res.json();
        responseContent = json.choices[0].message.content;
    } else {
        // 使用酒馆主 API
        responseContent = await context.generateQuietPrompt(systemPrompt, false, false, "System");
    }
    return responseContent.replace(/```json/g, '').replace(/```/g, '').trim();
}

// ============================================================================
// 4. UI 渲染与弹窗管理
// ============================================================================

// [主界面] 打开生成器弹窗
async function openCreatorPopup() {
    loadData();
    // 确保列表加载完成
    await loadAvailableWorldBooks();
    const savedState = loadState();
    const config = { ...defaultSettings, ...extension_settings[extensionName], ...savedState.localConfig };
    
    const context = getContext();
    let currentName = $('h5#your_name').text().trim();
    if (!currentName) currentName = context.powerUserSettings?.persona_selected || "User";

    const wiOptions = availableWorldBooks.length > 0 
        ? availableWorldBooks.map(b => `<option value="${b}">${b}</option>`).join('')
        : `<option disabled>未找到世界书 (请确保已创建)</option>`;

    // 构建 HTML 结构
    const html = `
    <div class="pw-wrapper">
        <div class="pw-header">
            <div class="pw-top-bar">
                <div class="pw-title"><i class="fa-solid fa-wand-magic-sparkles" style="color:#e0af68;"></i> 设定编织者 Pro</div>
            </div>
            <div class="pw-tabs">
                <div class="pw-tab active" data-tab="editor"><i class="fa-solid fa-pen-to-square"></i> 编辑</div>
                <div class="pw-tab" data-tab="context"><i class="fa-solid fa-book"></i> 世界书</div>
                <div class="pw-tab" data-tab="api"><i class="fa-solid fa-gear"></i> API</div>
                <div class="pw-tab" data-tab="history"><i class="fa-solid fa-clock-rotate-left"></i> 历史</div>
            </div>
        </div>

        <!-- 主编辑器视图 -->
        <div id="pw-view-editor" class="pw-view active">
            <div class="pw-editor-layout">
                
                <!-- 请求区 (上方，固定高度或少许滚动) -->
                <div class="pw-request-section">
                    <div class="pw-info-display">
                        <div class="pw-info-item"><i class="fa-solid fa-user"></i> <span id="pw-display-name">${currentName}</span></div>
                    </div>
                    <div>
                        <div class="pw-tags-header">
                            <span class="pw-tags-label">快速设定 (点击填入)</span>
                            <span class="pw-tags-edit-toggle" id="pw-toggle-edit-tags">编辑标签</span>
                        </div>
                        <div class="pw-tags-container" id="pw-tags-list"></div>
                    </div>
                    <textarea id="pw-request" class="pw-textarea" placeholder="在此输入初始设定要求 (例如：粉色头发，傲娇)..." style="height:60px; min-height:60px;">${savedState.request || ''}</textarea>
                    <button id="pw-btn-gen" class="pw-btn gen"><i class="fa-solid fa-bolt"></i> 生成设定</button>
                </div>

                <!-- 结果区 (中间，自适应高度) -->
                <div id="pw-result-area" class="pw-result-container" style="display:none;">
                    <div class="pw-result-header">
                        <span><i class="fa-solid fa-list-ul"></i> 设定结果</span>
                        <div class="pw-tool-icon" id="pw-btn-expand" title="全屏编辑" style="cursor:pointer;"><i class="fa-solid fa-expand"></i></div>
                    </div>
                    
                    <!-- 文本框：占据剩余空间，独立滚动 -->
                    <textarea id="pw-result-text" class="pw-result-textarea" placeholder="生成的结果将显示在这里..."></textarea>
                    
                    <!-- [布局优化] 润色工具栏：固定在文本框下方 -->
                    <div class="pw-refine-toolbar">
                        <!-- 使用 textarea 实现多行输入 -->
                        <textarea id="pw-refine-input" class="pw-refine-input" rows="1" placeholder="选中文字点击“引用”，或直接输入修改意见..."></textarea>
                        <div class="pw-tool-btn" id="pw-insert-selection" title="将选中的文字作为引用填入"><i class="fa-solid fa-quote-left"></i> 引用</div>
                        <div class="pw-tool-btn" id="pw-btn-refine" title="提交给 AI 进行修改"><i class="fa-solid fa-magic"></i> 润色</div>
                    </div>
                </div>

                <!-- 底部动作栏 (始终最底) -->
                <div class="pw-bottom-actions">
                    <div class="pw-bottom-left">
                        <div class="pw-mini-btn" id="pw-clear"><i class="fa-solid fa-eraser"></i> 清空</div>
                        <div class="pw-mini-btn" id="pw-snapshot"><i class="fa-solid fa-save"></i> 存入历史</div>
                    </div>
                    <div class="pw-bottom-right">
                        <div class="pw-wi-check-container">
                            <input type="checkbox" id="pw-wi-toggle" checked>
                            <span>同步进世界书</span>
                        </div>
                        <button id="pw-btn-apply" class="pw-btn save" style="width:auto;"><i class="fa-solid fa-check"></i> 保存并覆盖当前设定</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- 世界书 Tab -->
        <div id="pw-view-context" class="pw-view">
            <div class="pw-scroll-area">
                <div class="pw-card-section">
                    <div class="pw-wi-controls">
                        <select id="pw-wi-select" class="pw-input pw-wi-select">
                            <option value="">-- 添加参考世界书 --</option>
                            ${wiOptions}
                        </select>
                        <button id="pw-wi-add" class="pw-btn primary pw-wi-add-btn"><i class="fa-solid fa-plus"></i></button>
                    </div>
                </div>
                <div id="pw-wi-container"></div>
            </div>
        </div>

        <!-- API Tab -->
        <div id="pw-view-api" class="pw-view">
             <div class="pw-scroll-area">
                <div class="pw-card-section">
                    <div class="pw-row">
                        <label>API 来源</label>
                        <select id="pw-api-source" class="pw-input" style="flex:1;">
                            <option value="main" ${config.apiSource === 'main' ? 'selected' : ''}>使用主 API</option>
                            <option value="independent" ${config.apiSource === 'independent' ? 'selected' : ''}>独立 API</option>
                        </select>
                    </div>
                    <div id="pw-indep-settings" style="display:${config.apiSource === 'independent' ? 'flex' : 'none'}; flex-direction:column; gap:15px;">
                        <div class="pw-row"><label>URL</label><input type="text" id="pw-api-url" class="pw-input" value="${config.indepApiUrl}" style="flex:1;"></div>
                        <div class="pw-row"><label>Key</label><input type="password" id="pw-api-key" class="pw-input" value="${config.indepApiKey}" style="flex:1;"></div>
                        <div class="pw-row pw-api-model-row"><label>Model</label><div style="flex:1; display:flex; gap:5px; width:100%;"><input type="text" id="pw-api-model" class="pw-input" value="${config.indepApiModel}" list="pw-model-list" style="flex:1;"><datalist id="pw-model-list"></datalist><button id="pw-api-fetch" class="pw-btn primary pw-api-fetch-btn" title="获取模型" style="width:auto;"><i class="fa-solid fa-cloud-download-alt"></i></button></div></div>
                    </div>
                    <div style="text-align:right;"><button id="pw-api-save" class="pw-btn primary" style="width:auto;"><i class="fa-solid fa-save"></i> 保存设置</button></div>
                </div>
            </div>
        </div>

        <!-- 历史记录 Tab -->
        <div id="pw-view-history" class="pw-view">
            <div class="pw-scroll-area">
                <div class="pw-search-box"><input type="text" id="pw-history-search" class="pw-input pw-search-input" placeholder="🔍 搜索历史..."><i class="fa-solid fa-times pw-search-clear" id="pw-history-search-clear" title="清空搜索"></i></div>
                <div id="pw-history-list" style="display:flex; flex-direction:column;"></div>
                <button id="pw-history-clear-all" class="pw-btn danger"><i class="fa-solid fa-trash-alt"></i> 清空所有历史记录</button>
            </div>
        </div>
    </div>
    `;

    // 打开主弹窗
    callPopup(html, 'text', '', { wide: true, large: true, okButton: "关闭" });

    // 初始化渲染和事件绑定
    bindEvents();
    renderTagsList();
    renderWiBooks();
    
    // 恢复之前的状态
    if (savedState.hasResult || savedState.resultText) {
        $('#pw-result-text').val(savedState.resultText || "");
        $('#pw-result-area').show();
        setTimeout(() => $(window).trigger('resize'), 100);
    }
    
    // 恢复激活的 Tab
    if (savedState.activeTab) {
        $(`.pw-tab[data-tab="${savedState.activeTab}"]`).click();
    }
}

// [新] 对比审核弹窗 (Diff View)
async function openDiffPopup(originalText, newText) {
    const html = `
    <div style="display:flex; flex-direction:column; gap:10px; height:100%;">
        <div style="margin-bottom:5px; opacity:0.8;">请审查 AI 的修改建议。你可以直接在右侧编辑最终结果。</div>
        <div class="pw-diff-wrapper">
            <div class="pw-diff-pane">
                <div class="pw-diff-header">修改前 (只读)</div>
                <textarea class="pw-diff-content pw-diff-old" readonly>${originalText}</textarea>
            </div>
            <div class="pw-diff-pane">
                <div class="pw-diff-header">修改后 (可编辑)</div>
                <textarea id="pw-diff-result-final" class="pw-diff-content pw-diff-new">${newText}</textarea>
            </div>
        </div>
    </div>
    `;
    
    // 使用 callPopup 打开新层级
    const result = await callPopup(html, 'confirm', '', { 
        wide: true, 
        large: true, 
        okButton: "全部接受", 
        cancelButton: "取消修改" 
    });

    if (result === true) {
        // 用户点击了接受
        const finalVal = $('#pw-diff-result-final').val();
        // 保存状态并重新打开主界面
        captureCurrentState(); // 理论上这里的 state 还是旧的，需要手动更新 state 对象
        const state = loadState();
        state.resultText = finalVal; // 更新为新文本
        saveState(state);
        
        toastr.success("修改已应用");
        // 返回主界面
        openCreatorPopup();
    } else {
        toastr.info("已取消修改");
        // 返回主界面 (不改变内容)
        openCreatorPopup();
    }
}

// ============================================================================
// 5. 事件绑定与处理
// ============================================================================
function bindEvents() {
    $(document).off('.pw');
    
    // 输入框自动高度 (针对 textarea)
    $(document).on('input.pw', '#pw-refine-input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
    });

    // 监听输入变动，实时保存状态
    $(document).on('input.pw change.pw', '#pw-request, #pw-result-text, .pw-input', captureCurrentState);

    // Tab 切换逻辑
    $(document).on('click.pw', '.pw-tab', function() {
        $('.pw-tab').removeClass('active');
        $(this).addClass('active');
        $('.pw-view').removeClass('active');
        const tab = $(this).data('tab');
        $(`#pw-view-${tab}`).addClass('active');
        if(tab === 'history') renderHistoryList(); 
        captureCurrentState();
    });

    // [逻辑修正] 引用功能：支持追加与换行
    $(document).on('click.pw', '#pw-insert-selection', function() {
        const textarea = document.getElementById('pw-result-text');
        if (textarea) {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const selectedText = textarea.value.substring(start, end).trim();
            if (selectedText) {
                const $input = $('#pw-refine-input');
                const curVal = $input.val();
                // 如果已有内容，添加换行
                const prefix = curVal ? (curVal.endsWith('\n') ? '' : '\n') : '';
                const newText = `引用 "${selectedText}"：`;
                
                $input.val(curVal + prefix + newText).focus();
                // 触发 input 事件以调整高度
                $input.trigger('input');
            } else {
                toastr.info("请先在上方结果框中划选文字");
            }
        }
    });

    // [逻辑修正] 全屏编辑：返回时重新打开主界面
    $(document).on('click.pw', '#pw-btn-expand', function() {
        captureCurrentState(); // 保存当前状态
        const currentVal = $('#pw-result-text').val();
        const popupHtml = `<textarea id="pw-expanded-text" class="pw-textarea" style="width:100%; height:100%; font-size:1.1em; border:none;">${currentVal}</textarea>`;
        
        callPopup(popupHtml, 'confirm', '', { wide: true, large: true, okButton: "应用修改", cancelButton: "返回" })
            .then((result) => {
                if (result === true) {
                    const newVal = $('#pw-expanded-text').val();
                    const state = loadState();
                    state.resultText = newVal;
                    saveState(state);
                }
                // 无论是应用还是取消，都重新打开主界面（实现“返回”效果）
                openCreatorPopup();
            });
    });

    // [新流程] 润色：生成 -> Diff弹窗 -> 应用
    $(document).on('click.pw', '#pw-btn-refine', async function() {
        const refineReq = $('#pw-refine-input').val();
        if (!refineReq) return toastr.warning("请输入润色意见");
        
        captureCurrentState(); // 保存现场
        const currentRawText = $('#pw-result-text').val();
        const $btn = $(this);
        const oldHtml = $btn.html();
        
        $btn.html('<i class="fas fa-spinner fa-spin"></i> 处理中...');
        
        try {
            const config = {
                mode: 'refine',
                request: refineReq,
                currentText: currentRawText, 
                wiContext: getCheckedWiContext(),
                apiSource: $('#pw-api-source').val(),
                indepApiUrl: $('#pw-api-url').val(),
                indepApiKey: $('#pw-api-key').val(),
                indepApiModel: $('#pw-api-model').val()
            };
            
            const responseText = await runGeneration(config, config);
            
            // 清空润色输入框并调整高度
            $('#pw-refine-input').val('').trigger('input');
            
            // 打开对比弹窗 (该函数内部会处理“返回主界面”的逻辑)
            await openDiffPopup(currentRawText, responseText);
            
        } catch (e) { 
            toastr.error(`润色失败: ${e.message}`); 
            // 失败时不需要重新打开弹窗，因为当前弹窗未关闭
        } finally { 
            $btn.html(oldHtml); 
        }
    });

    // 生成按钮
    $(document).on('click.pw', '#pw-btn-gen', async function() {
        const req = $('#pw-request').val();
        if (!req) return toastr.warning("请输入要求");
        const $btn = $(this);
        const oldText = $btn.html();
        $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 生成中...');
        try {
            const config = {
                mode: 'initial',
                request: req,
                wiContext: getCheckedWiContext(),
                apiSource: $('#pw-api-source').val(),
                indepApiUrl: $('#pw-api-url').val(),
                indepApiKey: $('#pw-api-key').val(),
                indepApiModel: $('#pw-api-model').val()
            };
            const responseText = await runGeneration(config, config);
            $('#pw-result-text').val(responseText);
            $('#pw-result-area').fadeIn();
            captureCurrentState();
        } catch (e) { toastr.error(`${TEXT.TOAST_GEN_FAIL}: ${e.message}`); } 
        finally { $btn.prop('disabled', false).html(oldText); }
    });

    // 底部：清空
    $(document).on('click.pw', '#pw-clear', function() {
        if(confirm("清空所有输入内容？")) {
            $('#pw-request').val('');
            $('#pw-result-area').hide();
            $('#pw-result-text').val('');
            $('#pw-refine-input').val('').trigger('input');
            captureCurrentState();
        }
    });

    // 底部：存入历史
    $(document).on('click.pw', '#pw-snapshot', function() {
        const req = $('#pw-request').val();
        const curName = $('h5#your_name').text() || "User";
        const curText = $('#pw-result-text').val();
        if (!req && !curText) return toastr.warning("内容为空");
        saveHistory({ 
            request: req || "无请求内容", 
            timestamp: new Date().toLocaleString(),
            targetChar: getContext().characters?.[getContext().characterId]?.name || "Generic",
            data: { name: curName, resultText: curText } 
        });
        toastr.success(TEXT.TOAST_SNAPSHOT);
    });

    // 底部：保存应用
    $(document).on('click.pw', '#pw-btn-apply', async function() {
        const name = $('h5#your_name').text() || "User";
        const finalContent = $('#pw-result-text').val();
        
        if (!finalContent) return toastr.warning("内容为空");

        try {
            await forceSavePersona(name, finalContent);
            toastr.success(TEXT.TOAST_SAVE_SUCCESS(name));
        } catch (e) { toastr.error(e.message); return; }

        if ($('#pw-wi-toggle').is(':checked')) {
            const boundBooks = await getContextWorldBooks();
            let targetBook = null;
            if (window.pwExtraBooks && window.pwExtraBooks.length > 0) {
                targetBook = window.pwExtraBooks[0];
            } else if (boundBooks.length > 0) {
                targetBook = boundBooks[0];
            }
            
            if (targetBook) {
                try {
                    const h = getRequestHeaders();
                    const r = await fetch('/api/worldinfo/get', { method: 'POST', headers: h, body: JSON.stringify({ name: targetBook }) });
                    if (r.ok) {
                        const d = await r.json();
                        if (!d.entries) d.entries = {};
                        
                        const entryName = `User: ${name}`;
                        const entryKeys = [name, "User"]; 
                        let targetId = -1;
                        for (const [uid, entry] of Object.entries(d.entries)) {
                            if (entry.comment === entryName || (entry.key && entry.key.includes(name) && entry.key.includes("User"))) {
                                targetId = Number(uid);
                                break;
                            }
                        }
                        if (targetId === -1) {
                            const ids = Object.keys(d.entries).map(Number);
                            targetId = ids.length ? Math.max(...ids) + 1 : 0;
                        }
                        d.entries[targetId] = { 
                            uid: targetId, 
                            key: entryKeys, 
                            content: finalContent, 
                            comment: entryName, 
                            enabled: true, 
                            selective: true 
                        };
                        
                        await fetch('/api/worldinfo/edit', { method: 'POST', headers: h, body: JSON.stringify({ name: targetBook, data: d }) });
                        toastr.success(TEXT.TOAST_WI_SUCCESS(targetBook));
                        const context = getContext();
                        if (context.updateWorldInfoList) context.updateWorldInfoList();
                    }
                } catch(e) { console.error("WI Update Failed", e); }
            } else {
                toastr.warning(TEXT.TOAST_WI_FAIL);
            }
        }
        // 应用后关闭
        $('.popup_close').first().click();
    });
    
    // 杂项绑定
    $(document).on('click.pw', '#pw-toggle-edit-tags', () => { isEditingTags = !isEditingTags; renderTagsList(); });
    $(document).on('change.pw', '#pw-api-source', function() { $('#pw-indep-settings').toggle($(this).val() === 'independent'); });
    $(document).on('click.pw', '#pw-api-fetch', async function() { 
        const url = $('#pw-api-url').val();
        const key = $('#pw-api-key').val();
        if(!url) return toastr.warning("请输入URL");
        const $btn = $(this); $btn.html('<i class="fas fa-spinner fa-spin"></i>');
        try {
            // 复用之前的 fetchModels 逻辑，或简单实现
            const endpoint = url.includes('v1') ? `${url.replace(/\/$/, '')}/models` : `${url.replace(/\/$/, '')}/v1/models`;
            const res = await fetch(endpoint, { headers: { 'Authorization': `Bearer ${key}` }});
            const data = await res.json();
            const models = (data.data || data).map(m => m.id).sort();
            const $list = $('#pw-model-list').empty();
            models.forEach(m => $list.append(`<option value="${m}">`));
            toastr.success(`获取到 ${models.length} 个模型`);
        } catch(e) { toastr.error("获取模型列表失败"); }
        finally { $btn.html('<i class="fa-solid fa-cloud-download-alt"></i>'); }
    });
    $(document).on('click.pw', '#pw-api-save', () => { captureCurrentState(); toastr.success(TEXT.TOAST_SAVE_API); });
    
    // 历史记录相关
    $(document).on('input.pw', '#pw-history-search', renderHistoryList);
    $(document).on('click.pw', '#pw-history-search-clear', function() { $('#pw-history-search').val('').trigger('input'); });
    $(document).on('click.pw', '#pw-history-clear-all', function() { if(confirm("清空?")){historyCache=[];saveData();renderHistoryList();} });
    $(document).on('click.pw', '#pw-wi-add', () => { const val = $('#pw-wi-select').val(); if (val && !window.pwExtraBooks.includes(val)) { window.pwExtraBooks.push(val); renderWiBooks(); } });
}

function getCheckedWiContext() {
    const wiContext = [];
    $('.pw-wi-check:checked').each(function() { wiContext.push(decodeURIComponent($(this).data('content'))); });
    return wiContext;
}

// ============================================================================
// 6. 辅助渲染函数
// ============================================================================
const renderTagsList = () => {
    const $container = $('#pw-tags-list').empty();
    const $toggleBtn = $('#pw-toggle-edit-tags');
    $toggleBtn.text(isEditingTags ? '取消编辑' : '编辑标签');
    $toggleBtn.css('color', isEditingTags ? '#ff6b6b' : '#5b8db8');

    tagsCache.forEach((tag, index) => {
        if (isEditingTags) {
            const $row = $(`<div class="pw-tag-edit-row"><input class="pw-tag-edit-input t-name" value="${tag.name}"><input class="pw-tag-edit-input t-val" value="${tag.value}"><div class="pw-tag-del-btn"><i class="fa-solid fa-trash"></i></div></div>`);
            $row.find('input').on('input', function() { tag.name = $row.find('.t-name').val(); tag.value = $row.find('.t-val').val(); saveData(); });
            $row.find('.pw-tag-del-btn').on('click', () => { if (confirm("删除?")) { tagsCache.splice(index, 1); saveData(); renderTagsList(); } });
            $container.append($row);
        } else {
            const $chip = $(`<div class="pw-tag-chip"><i class="fa-solid fa-tag" style="opacity:0.5; margin-right:4px;"></i><span>${tag.name}</span>${tag.value ? `<span class="pw-tag-val">${tag.value}</span>` : ''}</div>`);
            $chip.on('click', () => {
                const tagText = tag.value ? `${tag.name}: ${tag.value}` : `${tag.name}`;
                // [逻辑修正] 仅填充请求框 (#pw-request)，不填充结果框或润色框
                const $text = $('#pw-request');
                const cur = $text.val();
                const prefix = (cur && !cur.endsWith('\n') && !cur.endsWith(' ')) ? ', ' : '';
                $text.val(cur + prefix + tagText).focus();
                $text[0].scrollTop = $text[0].scrollHeight;
                
                captureCurrentState(); 
            });
            $container.append($chip);
        }
    });
    const $addBtn = $(`<div class="pw-tag-add-btn"><i class="fa-solid fa-plus"></i> ${isEditingTags ? '新增' : '标签'}</div>`);
    $addBtn.on('click', () => { tagsCache.push({ name: "", value: "" }); saveData(); if (!isEditingTags) isEditingTags = true; renderTagsList(); });
    $container.append($addBtn);
    if (isEditingTags) {
        const $finishBtn = $(`<div class="pw-tags-finish-bar"><i class="fa-solid fa-check"></i> 完成编辑</div>`);
        $finishBtn.on('click', () => { isEditingTags = false; renderTagsList(); });
        $container.append($finishBtn);
    }
};

window.pwExtraBooks = [];
const renderWiBooks = async () => {
    const container = $('#pw-wi-container').empty();
    const baseBooks = await getContextWorldBooks();
    const allBooks = [...new Set([...baseBooks, ...(window.pwExtraBooks || [])])];

    if (allBooks.length === 0) {
        container.html('<div style="opacity:0.6; padding:10px; text-align:center;">未检测到绑定的世界书。请在上方下拉框选择并添加。</div>');
        return;
    }
    
    for (const book of allBooks) {
        const isBound = baseBooks.includes(book);
        const $el = $(`
            <div class="pw-wi-book">
                <div class="pw-wi-header">
                    <span><i class="fa-solid fa-book"></i> ${book} ${isBound ? '<span style="color:#9ece6a;font-size:0.8em;margin-left:5px;">(已绑定)</span>' : ''}</span>
                    <div>${!isBound ? '<i class="fa-solid fa-times remove-book" style="color:#ff6b6b;margin-right:10px;" title="移除"></i>' : ''}<i class="fa-solid fa-chevron-down arrow"></i></div>
                </div>
                <div class="pw-wi-list" data-book="${book}"></div>
            </div>
        `);
        $el.find('.remove-book').on('click', (e) => { e.stopPropagation(); window.pwExtraBooks = window.pwExtraBooks.filter(b => b !== book); renderWiBooks(); });
        $el.find('.pw-wi-header').on('click', async function() {
            const $list = $el.find('.pw-wi-list');
            const $arrow = $(this).find('.arrow');
            if ($list.is(':visible')) { $list.slideUp(); $arrow.removeClass('fa-flip-vertical'); } else {
                $list.slideDown(); $arrow.addClass('fa-flip-vertical');
                if (!$list.data('loaded')) {
                    $list.html('<div style="padding:10px;text-align:center;"><i class="fas fa-spinner fa-spin"></i></div>');
                    const entries = await getWorldBookEntries(book);
                    $list.empty();
                    if (entries.length === 0) $list.html('<div style="padding:10px;opacity:0.5;">无条目</div>');
                    entries.forEach(entry => {
                        const isChecked = entry.enabled ? 'checked' : '';
                        const $item = $(`<div class="pw-wi-item"><div class="pw-wi-item-row"><input type="checkbox" class="pw-wi-check" ${isChecked} data-content="${encodeURIComponent(entry.content)}"><div style="font-weight:bold; font-size:0.9em; flex:1;">${entry.displayName}</div><i class="fa-solid fa-eye pw-wi-toggle-icon"></i></div><div class="pw-wi-desc">${entry.content}<div class="pw-wi-close-bar"><i class="fa-solid fa-angle-up"></i> 收起</div></div></div>`);
                        $item.find('.pw-wi-toggle-icon').on('click', function(e) { e.stopPropagation(); const $desc = $(this).closest('.pw-wi-item').find('.pw-wi-desc'); if($desc.is(':visible')) { $desc.slideUp(); $(this).css('color', ''); } else { $desc.slideDown(); $(this).css('color', '#5b8db8'); } });
                        $item.find('.pw-wi-close-bar').on('click', function() { $(this).parent().slideUp(); $item.find('.pw-wi-toggle-icon').css('color', ''); });
                        $list.append($item);
                    });
                    $list.data('loaded', true);
                }
            }
        });
        container.append($el);
    }
};

const renderHistoryList = () => {
    loadData();
    const $list = $('#pw-history-list').empty();
    const search = $('#pw-history-search').val().toLowerCase();
    const filtered = historyCache.filter(item => {
        if (!search) return true;
        const name = (item.data.name || "").toLowerCase();
        const content = (item.data.resultText || "").toLowerCase();
        return name.includes(search) || content.includes(search);
    });
    if (filtered.length === 0) { $list.html('<div style="text-align:center; opacity:0.6; padding:20px;">暂无历史记录</div>'); return; }
    filtered.forEach((item, index) => {
        const displayTitle = item.data.name || "未命名";
        const previewText = item.data.resultText || '无内容';
        const $el = $(`<div class="pw-history-item"><div class="pw-hist-main"><div style="font-weight:bold; color:#e0af68;">${displayTitle}</div><div class="pw-hist-meta"><span>${item.timestamp || ''}</span></div><div class="pw-hist-desc">${previewText}</div></div><div class="pw-hist-del-btn"><i class="fa-solid fa-trash"></i></div></div>`);
        $el.on('click', function(e) {
            if ($(e.target).closest('.pw-hist-del-btn').length) return;
            // 恢复历史记录到状态
            const state = loadState();
            state.request = item.request;
            state.resultText = previewText;
            state.hasResult = true;
            state.activeTab = 'editor';
            saveState(state);
            // 重新渲染主界面
            openCreatorPopup();
        });
        $el.find('.pw-hist-del-btn').on('click', function(e) { e.stopPropagation(); if(confirm("删除?")) { historyCache.splice(historyCache.indexOf(item), 1); saveData(); renderHistoryList(); } });
        $list.append($el);
    });
};

function addPersonaButton() {
    const container = $('.persona_controls_buttons_block');
    if (container.length === 0 || $(`#${BUTTON_ID}`).length > 0) return;
    const newButton = $(`<div id="${BUTTON_ID}" class="menu_button fa-solid fa-wand-magic-sparkles interactable" title="${TEXT.BTN_TITLE}" tabindex="0" role="button"></div>`);
    newButton.on('click', openCreatorPopup);
    container.prepend(newButton);
}

jQuery(async () => {
    injectStyles();
    addPersonaButton();
    const observer = new MutationObserver(() => { if ($(`#${BUTTON_ID}`).length === 0 && $('.persona_controls_buttons_block').length > 0) addPersonaButton(); });
    observer.observe(document.body, { childList: true, subtree: true });
    console.log(`${extensionName} v21 loaded.`);
});
