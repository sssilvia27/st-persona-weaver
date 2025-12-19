import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, callPopup, getRequestHeaders } from "../../../../script.js";

// ============================================================================
// 1. 常量与配置
// ============================================================================
const extensionName = "st-persona-weaver";
const STORAGE_KEY_HISTORY = 'pw_history_v19';
const STORAGE_KEY_STATE = 'pw_state_v19'; 
const STORAGE_KEY_TAGS = 'pw_tags_v12';
const BUTTON_ID = 'pw_persona_tool_btn';

const defaultTags = [
    { name: "性别", value: "" },
    { name: "年龄", value: "" },
    { name: "MBTI", value: "" },
    { name: "职业", value: "" },
    { name: "阵营", value: "" },
    { name: "外貌", value: "" },
    { name: "性格", value: "" },
    { name: "关系", value: "" },
    { name: "XP", value: "" },
    { name: "秘密", value: "" }
];
const defaultSettings = {
    autoSwitchPersona: true,
    syncToWorldInfo: true,
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
// 2. 核心逻辑函数
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
function saveState(data) {
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(data));
}
function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_STATE)) || {}; } catch { return {}; }
}
function injectStyles() {
    // 假设样式已通过 link 或 style 标签加载，此处仅为占位
}

// [核心] 暴力写入 Persona
async function forceSavePersona(name, description) {
    const context = getContext();
    if (!context.powerUserSettings.personas) context.powerUserSettings.personas = {};
    context.powerUserSettings.personas[name] = description;
    context.powerUserSettings.persona_selected = name;
    
    // UI 更新
    $('#your_name').val(name).trigger('input').trigger('change');
    $('#persona_description').val(description).trigger('input').trigger('change');
    $('h5#your_name').text(name);

    await saveSettingsDebounced();
    console.log(`[PW] Persona "${name}" updated.`);
    return true;
}

// [修复] 获取所有可用世界书列表
async function loadAvailableWorldBooks() {
    availableWorldBooks = [];
    try {
        const context = getContext();
        // 尝试使用 ST 内置方法获取列表
        if (context.worldInfoNames) {
             availableWorldBooks = context.worldInfoNames;
        } else {
            // Fallback: 使用 API
            const response = await fetch('/api/worldinfo/titles', { method: 'POST', headers: getRequestHeaders() });
            if (response.ok) {
                const data = await response.json();
                availableWorldBooks = data.world_names || data;
            }
        }
    } catch (e) { console.error("[PW] Worldbook list load failed", e); }
    availableWorldBooks = [...new Set(availableWorldBooks)].filter(x => x).sort();
}

// 获取当前上下文绑定的世界书
async function getContextWorldBooks(extras = []) {
    const context = getContext();
    const books = new Set(extras); 
    const charId = context.characterId;
    // 即使没有角色卡，也可能通过其他方式绑定了书（例如全局）
    if (charId !== undefined && context.characters[charId]) {
        const char = context.characters[charId];
        const data = char.data || char;
        if (data.character_book?.name) books.add(data.character_book.name);
        if (data.extensions?.world) books.add(data.extensions.world);
        if (data.world) books.add(data.world);
    }
    if (context.chatMetadata?.world_info) books.add(context.chatMetadata.world_info);
    
    // 加上全局世界书 (如果有 API 支持)
    if (context.worldInfoSettings?.globalSelect) {
        context.worldInfoSettings.globalSelect.forEach(b => books.add(b));
    }

    return Array.from(books).filter(Boolean);
}

// 获取世界书内容
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

// [核心] 生成与润色逻辑
async function runGeneration(data, apiConfig) {
    const context = getContext();
    // [修改] 如果没有角色卡，提供默认值
    const char = (context.characterId !== undefined && context.characters[context.characterId]) 
        ? context.characters[context.characterId] 
        : { name: "Character", scenario: "Generic Scenario" };
    
    const currentName = $('h5#your_name').text().trim() || "User";
    let wiText = "";
    if (data.wiContext && data.wiContext.length > 0) {
        wiText = `\n[Context from World Info]:\n${data.wiContext.join('\n\n')}\n`;
    }
    
    let systemPrompt = "";
    if (data.mode === 'refine') {
        systemPrompt = `You are a creative writing assistant optimizing a User Persona.
Target Character: ${char.name}
Scenario: ${char.scenario || "None"}
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
        const targetKeys = tagsCache.map(t => t.name).filter(n => n).join(', ');
        systemPrompt = `You are a creative writing assistant creating a User Persona.
Target Character: ${char.name}
Scenario: ${char.scenario || "None"}
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

    // 调用 API
    let responseContent = "";
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
        if (!res.ok) throw new Error("Independent API Error");
        const json = await res.json();
        responseContent = json.choices[0].message.content;
    } else {
        // 使用 ST 主 API
        responseContent = await context.generateQuietPrompt(systemPrompt, false, false, "System");
    }
    return responseContent.replace(/```json/g, '').replace(/```/g, '').trim();
}

// [新增] 显示对比弹窗
async function showDiffPopup(oldText, newText) {
    const html = `
    <div class="pw-diff-container">
        <div style="opacity:0.7; margin-bottom:5px;">请对比修改前后的内容，选择应用方式：</div>
        <div class="pw-diff-panels">
            <div class="pw-diff-box">
                <div class="pw-diff-label">修改前 (Original)</div>
                <textarea class="pw-diff-text old" readonly>${oldText}</textarea>
            </div>
            <div class="pw-diff-box">
                <div class="pw-diff-label">修改后 (New)</div>
                <textarea class="pw-diff-text new" id="pw-diff-new-val">${newText}</textarea>
            </div>
        </div>
    </div>
    `;
    const result = await callPopup(html, 'confirm', '', { 
        wide: true, 
        large: true, 
        okButton: "全部应用 (Apply All)", 
        cancelButton: "取消 (Cancel)",
        customButtons: [{ text: "应用已编辑的新版 (Apply Edited)", result: 2 }] // 允许用户在右侧微调后应用
    });

    if (result === true) {
        // Apply All
        $('#pw-result-text').val(newText).trigger('input');
        toastr.success("已应用修改");
    } else if (result === 2) {
        // Apply Edited
        const editedNew = $('#pw-diff-new-val').val();
        $('#pw-result-text').val(editedNew).trigger('input');
        toastr.success("已应用编辑后的修改");
    }
}

// ============================================================================
// 3. UI 渲染
// ============================================================================
async function openCreatorPopup() {
    loadData();
    await loadAvailableWorldBooks();
    const savedState = loadState();
    const context = getContext();
    const config = { ...defaultSettings, ...extension_settings[extensionName], ...savedState.localConfig };
    
    let currentName = $('h5#your_name').text().trim();
    if (!currentName) currentName = context.powerUserSettings?.persona_selected || "User";

    // 渲染世界书添加列表的选项
    // [修复] 这里生成一个带筛选功能的 HTML 结构，稍后在 renderWiBooks 完善
    
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

        <div id="pw-view-editor" class="pw-view active">
            <div class="pw-scroll-area">
                
                <div class="pw-info-display">
                    <div class="pw-info-item">
                        <i class="fa-solid fa-user"></i>
                        <span id="pw-display-name">${currentName}</span>
                    </div>
                </div>

                <div>
                    <div class="pw-tags-header">
                        <span class="pw-tags-label">设定参考 (标签)</span>
                        <span class="pw-tags-edit-toggle" id="pw-toggle-edit-tags">编辑标签</span>
                    </div>
                    <div class="pw-tags-container" id="pw-tags-list"></div>
                </div>

                <textarea id="pw-request" class="pw-textarea" placeholder="在此输入初始设定要求..." style="min-height:80px;">${savedState.request || ''}</textarea>
                <button id="pw-btn-gen" class="pw-btn gen"><i class="fa-solid fa-bolt"></i> 生成设定</button>

                <!-- 结果展示区域 -->
                <div id="pw-result-area" style="display:none; margin-top:10px;">
                    <div style="font-weight:bold; color:#5b8db8; margin-bottom:5px;"><i class="fa-solid fa-list-ul"></i> 设定详情</div>
                    
                    <!-- 结果文本框在上面 -->
                    <textarea id="pw-result-text" class="pw-result-textarea" placeholder="生成的结果将显示在这里..."></textarea>
                    
                    <!-- [修改] 润色工具栏在下面 -->
                    <div class="pw-refine-toolbar">
                        <textarea id="pw-refine-input" class="pw-refine-textarea" placeholder="选中上方文字点击'引用'，或直接输入修改意见..." rows="1"></textarea>
                        <div class="pw-refine-actions">
                            <div class="pw-tool-icon" id="pw-insert-selection" title="引用：将选中的文字填入修改框"><i class="fa-solid fa-quote-left"></i> 引用</div>
                            <div class="pw-tool-icon" id="pw-btn-refine" title="执行润色"><i class="fa-solid fa-magic"></i> 润色</div>
                            <div class="pw-tool-icon" id="pw-btn-expand" title="全屏编辑"><i class="fa-solid fa-expand"></i></div>
                        </div>
                    </div>

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
                            <button id="pw-btn-apply" class="pw-btn save" style="width:auto;"><i class="fa-solid fa-check"></i> 保存并应用</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div id="pw-view-context" class="pw-view">
            <div class="pw-scroll-area">
                <div class="pw-card-section">
                    <div class="pw-wi-filter-wrapper">
                        <input type="text" id="pw-wi-add-filter" class="pw-input pw-wi-filter-input" placeholder="搜索所有世界书...">
                    </div>
                    <div class="pw-wi-list-container" id="pw-wi-add-list">
                        <!-- JS 填充 -->
                    </div>
                </div>
                <div style="font-weight:bold; margin: 5px 0 5px 0;">当前上下文参考书目：</div>
                <div id="pw-wi-container"></div>
            </div>
        </div>

        <!-- API 和 History 视图保持大致不变 -->
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
                        <div class="pw-row pw-api-model-row"><label>Model</label><input type="text" id="pw-api-model" class="pw-input" value="${config.indepApiModel}" style="flex:1;"></div>
                    </div>
                    <div style="text-align:right;"><button id="pw-api-save" class="pw-btn primary" style="width:auto;"><i class="fa-solid fa-save"></i> 保存设置</button></div>
                </div>
            </div>
        </div>

        <div id="pw-view-history" class="pw-view">
            <div class="pw-scroll-area">
                <div class="pw-search-box"><input type="text" id="pw-history-search" class="pw-input pw-search-input" placeholder="🔍 搜索历史..."><i class="fa-solid fa-times pw-search-clear" id="pw-history-search-clear" title="清空搜索"></i></div>
                <div id="pw-history-list" style="display:flex; flex-direction:column;"></div>
                <button id="pw-history-clear-all" class="pw-btn danger"><i class="fa-solid fa-trash-alt"></i> 清空所有历史记录</button>
            </div>
        </div>
    </div>
    `;

    callPopup(html, 'text', '', { wide: true, large: true, okButton: "关闭" });

    bindEvents();
    renderTagsList();
    renderWiBooks(); // 渲染已绑定
    renderWiAddList(); // 渲染可添加列表
    
    if (savedState.resultText) {
        $('#pw-result-text').val(savedState.resultText);
        $('#pw-result-area').show();
    }
}

// 自动调整 textarea 高度
function autoResizeTextarea(el) {
    el.style.height = 'auto';
    el.style.height = (el.scrollHeight) + 'px';
}

// ============================================================================
// 4. 事件绑定
// ============================================================================
function bindEvents() {
    $(document).off('.pw');

    const saveCurrentState = () => {
        saveState({
            request: $('#pw-request').val(),
            resultText: $('#pw-result-text').val(),
            hasResult: $('#pw-result-area').is(':visible'),
            localConfig: {
                apiSource: $('#pw-api-source').val(),
                indepApiUrl: $('#pw-api-url').val(),
                indepApiKey: $('#pw-api-key').val(),
                indepApiModel: $('#pw-api-model').val(),
                extraBooks: window.pwExtraBooks || []
            }
        });
    };

    $(document).on('input.pw change.pw', '#pw-request, #pw-result-text, .pw-input', saveCurrentState);
    
    // 监听润色框输入以自动增高
    $(document).on('input.pw', '#pw-refine-input', function() {
        autoResizeTextarea(this);
    });

    $(document).on('click.pw', '.pw-tab', function() {
        $('.pw-tab').removeClass('active');
        $(this).addClass('active');
        $('.pw-view').removeClass('active');
        const tab = $(this).data('tab');
        $(`#pw-view-${tab}`).addClass('active');
        if(tab === 'history') renderHistoryList(); 
    });

    // [修改] 引用逻辑：追加文本
    $(document).on('click.pw', '#pw-insert-selection', function() {
        const textarea = document.getElementById('pw-result-text');
        if (textarea) {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const selectedText = textarea.value.substring(start, end).trim();
            
            const $refineInput = $('#pw-refine-input');
            const currentVal = $refineInput.val();
            
            if (selectedText) {
                const prefix = currentVal ? "\n" : ""; // 如果已有内容，先换行
                const appendText = `${prefix}引用: "${selectedText}" -> 修改为: `;
                $refineInput.val(currentVal + appendText).focus();
                
                // 自动滚动到底部并调整高度
                const el = $refineInput[0];
                el.scrollTop = el.scrollHeight;
                autoResizeTextarea(el);
            } else {
                toastr.info("请先在上方设定详情文本框中划选文字");
            }
        }
    });

    // [修改] 全屏编辑：应用时不关闭
    $(document).on('click.pw', '#pw-btn-expand', function() {
        const currentVal = $('#pw-result-text').val();
        const popupHtml = `<textarea id="pw-expanded-text" class="pw-textarea" style="width:100%; height:600px; resize:none;">${currentVal}</textarea>`;
        callPopup(popupHtml, 'text', '', { wide: true, large: true, okButton: "应用修改 (返回)" })
            .then(() => {
                const newVal = $('#pw-expanded-text').val();
                if (newVal !== undefined) {
                    $('#pw-result-text').val(newVal).trigger('input');
                }
            });
    });

    // 清空与存入历史
    $(document).on('click.pw', '#pw-clear', function() {
        if(confirm("清空所有输入内容？")) {
            $('#pw-request').val('');
            $('#pw-result-area').hide();
            $('#pw-result-text').val('');
            $('#pw-refine-input').val('');
            saveCurrentState();
        }
    });
    $(document).on('click.pw', '#pw-snapshot', function() {
        const req = $('#pw-request').val();
        const curName = $('h5#your_name').text();
        const curText = $('#pw-result-text').val();
        if (!req && !curText) return toastr.warning("内容为空");
        saveHistory({ 
            request: req || "无请求内容", 
            timestamp: new Date().toLocaleString(),
            targetChar: getContext().characters[getContext().characterId]?.name || "未知",
            data: { name: curName, resultText: curText } 
        });
        toastr.success(TEXT.TOAST_SNAPSHOT);
    });

    // 生成逻辑
    $(document).on('click.pw', '#pw-btn-gen', async function() {
        const req = $('#pw-request').val();
        if (!req) return toastr.warning("请输入要求");
        const $btn = $(this);
        const oldText = $btn.html();
        $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 生成中...');
        try {
            const wiContext = [];
            $('.pw-wi-check:checked').each(function() { wiContext.push(decodeURIComponent($(this).data('content'))); });
            const config = {
                mode: 'initial',
                request: req,
                wiContext: wiContext,
                apiSource: $('#pw-api-source').val(),
                indepApiUrl: $('#pw-api-url').val(),
                indepApiKey: $('#pw-api-key').val(),
                indepApiModel: $('#pw-api-model').val()
            };
            const responseText = await runGeneration(config, config);
            $('#pw-result-text').val(responseText);
            $('#pw-result-area').fadeIn();
            saveCurrentState();
        } catch (e) { toastr.error(`${TEXT.TOAST_GEN_FAIL}: ${e.message}`); } 
        finally { $btn.prop('disabled', false).html(oldText); }
    });

    // [修改] 润色逻辑：展示对比
    $(document).on('click.pw', '#pw-btn-refine', async function() {
        const refineReq = $('#pw-refine-input').val();
        if (!refineReq) return toastr.warning("请输入润色意见");
        const currentRawText = $('#pw-result-text').val();
        const $btn = $(this);
        $btn.html('<i class="fas fa-spinner fa-spin"></i>'); 
        
        try {
            const config = {
                mode: 'refine',
                request: refineReq,
                currentText: currentRawText, 
                apiSource: $('#pw-api-source').val(),
                indepApiUrl: $('#pw-api-url').val(),
                indepApiKey: $('#pw-api-key').val(),
                indepApiModel: $('#pw-api-model').val()
            };
            const responseText = await runGeneration(config, config);
            
            // 弹出对比
            await showDiffPopup(currentRawText, responseText);
            
            $('#pw-refine-input').val('').css('height', 'auto'); 
            saveCurrentState();
        } catch (e) { toastr.error(`润色失败: ${e.message}`); }
        finally { $btn.html('<i class="fa-solid fa-magic"></i> 润色'); }
    });

    // 保存逻辑保持大体不变，但因为移除了 Char 依赖，需要更健壮
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
                            uid: targetId, key: entryKeys, content: finalContent, comment: entryName, enabled: true, selective: true 
                        };
                        await fetch('/api/worldinfo/edit', { method: 'POST', headers: h, body: JSON.stringify({ name: targetBook, data: d }) });
                        toastr.success(TEXT.TOAST_WI_SUCCESS(targetBook));
                    }
                } catch(e) { console.error("WI Update Failed", e); }
            } else {
                toastr.warning("未找到绑定的世界书，仅保存了 Persona。请在世界书页签绑定一本。");
            }
        }
        $('.popup_close').click();
    });

    $(document).on('click.pw', '#pw-toggle-edit-tags', () => { isEditingTags = !isEditingTags; renderTagsList(); });
    $(document).on('change.pw', '#pw-api-source', function() { $('#pw-indep-settings').toggle($(this).val() === 'independent'); });
    $(document).on('click.pw', '#pw-api-save', () => { saveCurrentState(); toastr.success(TEXT.TOAST_SAVE_API); });
    
    // 历史记录相关
    $(document).on('input.pw', '#pw-history-search', renderHistoryList);
    $(document).on('click.pw', '#pw-history-search-clear', function() { $('#pw-history-search').val('').trigger('input'); });
    $(document).on('click.pw', '#pw-history-clear-all', function() { if(confirm("清空?")){historyCache=[];saveData();renderHistoryList();} });
    
    // [新增] 世界书搜索与添加
    $(document).on('input.pw', '#pw-wi-add-filter', function() { renderWiAddList($(this).val()); });
}

// ============================================================================
// 5. 辅助渲染函数
// ============================================================================
const renderTagsList = () => {
    const $container = $('#pw-tags-list').empty();
    const $toggleBtn = $('#pw-toggle-edit-tags');
    $toggleBtn.text(isEditingTags ? '完成编辑' : '编辑标签');
    $toggleBtn.css('color', isEditingTags ? '#ff6b6b' : '#5b8db8');

    tagsCache.forEach((tag, index) => {
        if (isEditingTags) {
            const $row = $(`<div class="pw-tag-edit-row"><input class="pw-tag-edit-input t-name" value="${tag.name}"><input class="pw-tag-edit-input t-val" value="${tag.value}"><div class="pw-tag-del-btn"><i class="fa-solid fa-trash"></i></div></div>`);
            $row.find('input').on('input', function() { tag.name = $row.find('.t-name').val(); tag.value = $row.find('.t-val').val(); saveData(); });
            $row.find('.pw-tag-del-btn').on('click', () => { if (confirm("删除?")) { tagsCache.splice(index, 1); saveData(); renderTagsList(); } });
            $container.append($row);
        } else {
            // [修改] 移除了点击事件
            const $chip = $(`<div class="pw-tag-chip"><i class="fa-solid fa-tag" style="opacity:0.5; margin-right:4px;"></i><span>${tag.name}</span>${tag.value ? `<span class="pw-tag-val">${tag.value}</span>` : ''}</div>`);
            $container.append($chip);
        }
    });

    const $addBtn = $(`<div class="pw-tag-add-btn"><i class="fa-solid fa-plus"></i> ${isEditingTags ? '新增' : '标签'}</div>`);
    $addBtn.on('click', () => { tagsCache.push({ name: "", value: "" }); saveData(); if (!isEditingTags) isEditingTags = true; renderTagsList(); });
    $container.append($addBtn);
};

window.pwExtraBooks = [];

// [新增] 渲染世界书添加列表
const renderWiAddList = (filter = "") => {
    const $list = $('#pw-wi-add-list').empty();
    const lowerFilter = filter.toLowerCase();
    
    // 过滤掉已经绑定的
    getContextWorldBooks().then(baseBound => {
        const boundSet = new Set([...baseBound, ...(window.pwExtraBooks || [])]);
        
        const filteredBooks = availableWorldBooks.filter(b => 
            b.toLowerCase().includes(lowerFilter) && !boundSet.has(b)
        );

        if (filteredBooks.length === 0) {
            $list.html('<div style="opacity:0.6; text-align:center; padding:5px;">未找到匹配的世界书</div>');
            return;
        }

        filteredBooks.forEach(book => {
            const $row = $(`
                <div class="pw-wi-entry-row">
                    <span class="pw-wi-entry-name">${book}</span>
                    <i class="fa-solid fa-plus pw-wi-add-action" title="添加到上下文"></i>
                </div>
            `);
            $row.on('click', () => {
                if (!window.pwExtraBooks.includes(book)) {
                    window.pwExtraBooks.push(book);
                    renderWiBooks(); // 重新渲染已绑定列表
                    renderWiAddList(filter); // 刷新本列表（移除已添加项）
                }
            });
            $list.append($row);
        });
    });
};

// 渲染已绑定的世界书（带展开功能）
const renderWiBooks = async () => {
    const container = $('#pw-wi-container').empty();
    const baseBooks = await getContextWorldBooks();
    const allBooks = [...new Set([...baseBooks, ...(window.pwExtraBooks || [])])];

    if (allBooks.length === 0) {
        container.html('<div style="opacity:0.6; padding:10px; text-align:center;">暂无上下文世界书。请在上方搜索并添加。</div>');
        return;
    }

    for (const book of allBooks) {
        const isBound = baseBooks.includes(book);
        const $el = $(`
            <div class="pw-wi-book">
                <div class="pw-wi-header">
                    <span><i class="fa-solid fa-book"></i> ${book} ${isBound ? '<span style="color:#9ece6a;font-size:0.8em;margin-left:5px;">(自动绑定)</span>' : '<span style="color:#5b8db8;font-size:0.8em;margin-left:5px;">(手动添加)</span>'}</span>
                    <div>${!isBound ? '<i class="fa-solid fa-times remove-book" style="color:#ff6b6b;margin-right:10px;" title="移除"></i>' : ''}<i class="fa-solid fa-chevron-down arrow"></i></div>
                </div>
                <div class="pw-wi-list" data-book="${book}"></div>
            </div>
        `);
        $el.find('.remove-book').on('click', (e) => { 
            e.stopPropagation(); 
            window.pwExtraBooks = window.pwExtraBooks.filter(b => b !== book); 
            renderWiBooks(); 
            renderWiAddList($('#pw-wi-add-filter').val());
        });
        
        // ... 条目加载逻辑保持不变 ...
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
    // ... 历史记录渲染逻辑保持不变 ...
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
            $('#pw-request').val(item.request);
            $('#pw-result-text').val(previewText); 
            $('#pw-result-area').show();
            $('.pw-tab[data-tab="editor"]').click();
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
    console.log(`${extensionName} v18 loaded.`);
});
