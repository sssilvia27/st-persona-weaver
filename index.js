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
    historyLimit: 50,
    apiSource: 'main', 
    indepApiUrl: 'https://api.openai.com/v1',
    indepApiKey: '',
    indepApiModel: 'gpt-3.5-turbo'
};

const TEXT = {
    PANEL_TITLE: "用户设定编织者 Pro",
    BTN_TITLE: "打开设定生成器",
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
    const styleId = 'persona-weaver-css-v19';
    if ($(`#${styleId}`).length) return;
    // 这里依赖同目录下的 style.css 已经加载，或者你是直接打包的
}

// [核心] 暴力写入 Persona
async function forceSavePersona(name, description) {
    const context = getContext();
    if (!context.powerUserSettings.personas) context.powerUserSettings.personas = {};
    context.powerUserSettings.personas[name] = description;
    
    // 强制选中
    context.powerUserSettings.persona_selected = name;
    
    // 尝试更新设置面板 UI
    const $nameInput = $('#your_name');
    const $descInput = $('#persona_description');
    if ($nameInput.length) $nameInput.val(name).trigger('input').trigger('change');
    if ($descInput.length) $descInput.val(description).trigger('input').trigger('change');
    
    // 强制更新主界面显示
    const $h5Name = $('h5#your_name');
    if ($h5Name.length) $h5Name.text(name);

    await saveSettingsDebounced();
    console.log(`[PW] Persona "${name}" updated.`);
    return true;
}

// 获取所有可用的世界书列表
async function loadAvailableWorldBooks() {
    try {
        const response = await fetch('/api/worldinfo/get', { 
            method: 'POST', 
            headers: getRequestHeaders(), 
            body: JSON.stringify({}) // 空 body 获取列表
        });
        if (response.ok) {
            const data = await response.json();
            // 处理不同版本的 ST API 返回结构
            if (Array.isArray(data)) {
                return data.map(item => item.name || item).sort();
            } else if (data && data.world_names) {
                return data.world_names.sort();
            }
        }
    } catch (e) { console.error("[PW] Worldbook list load failed", e); }
    return [];
}

// 获取当前上下文绑定的世界书
async function getContextWorldBooks() {
    const context = getContext();
    const books = new Set(); 
    const charId = context.characterId;

    if (charId !== undefined && context.characters[charId]) {
        const char = context.characters[charId];
        const data = char.data || char;
        if (data.character_book?.name) books.add(data.character_book.name);
        if (data.extensions?.world) books.add(data.extensions.world);
        if (data.world) books.add(data.world);
    }
    if (context.chatMetadata?.world_info) books.add(context.chatMetadata.world_info);
    
    return Array.from(books).filter(Boolean);
}

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
async function runGeneration(data) {
    const context = getContext();
    const char = context.characters[context.characterId];
    
    // 获取当前名字
    const currentName = $('h5#your_name').text().trim() || "User";
    
    let wiText = "";
    if (data.wiContext && data.wiContext.length > 0) {
        wiText = `\n[Context from World Info]:\n${data.wiContext.join('\n\n')}\n`;
    }
    
    let charInfo = "Target Character: None (No character selected)";
    if (char) {
        charInfo = `Target Character: ${char.name}\nScenario: ${char.scenario || "None"}`;
    }

    let systemPrompt = "";
    
    if (data.mode === 'refine') {
        systemPrompt = `You are a creative writing assistant optimizing a User Persona.
${charInfo}
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
${charInfo}
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
    const apiSource = $('#pw-api-source').val();
    
    if (apiSource === 'independent') {
        const url = $('#pw-api-url').val().replace(/\/$/, '') + '/chat/completions';
        const apiKey = $('#pw-api-key').val();
        const model = $('#pw-api-model').val();

        const body = {
            model: model,
            messages: [{ role: 'system', content: systemPrompt }],
            temperature: 0.7
        };
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error("Independent API Error");
        const json = await res.json();
        responseContent = json.choices[0].message.content;
    } else {
        responseContent = await context.generateQuietPrompt(systemPrompt, false, false, "System");
    }

    return responseContent.replace(/```json/g, '').replace(/```/g, '').trim();
}

// ============================================================================
// 3. UI 渲染
// ============================================================================

// 打开主弹窗
async function openCreatorPopup() {
    const context = getContext();
    loadData();
    const savedState = loadState();
    const config = { ...defaultSettings, ...extension_settings[extensionName], ...savedState.localConfig };
    
    let currentName = $('h5#your_name').text().trim();
    if (!currentName) currentName = context.powerUserSettings?.persona_selected || "User";

    // 预加载所有世界书 (用于下拉框)
    const allServerBooks = await loadAvailableWorldBooks();
    const wiOptions = allServerBooks.length > 0 
        ? allServerBooks.map(b => `<option value="${b}">${b}</option>`).join('')
        : `<option disabled>API未返回世界书</option>`;

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
                
                <!-- 只读名字展示 -->
                <div class="pw-info-display">
                    <div class="pw-info-item">
                        <i class="fa-solid fa-user"></i>
                        <span id="pw-display-name">${currentName}</span>
                    </div>
                </div>

                <!-- 标签与输入 -->
                <div>
                    <div class="pw-tags-header">
                        <span class="pw-tags-label">设定参考标签</span>
                        <span class="pw-tags-edit-toggle" id="pw-toggle-edit-tags">编辑标签</span>
                    </div>
                    <div class="pw-tags-container" id="pw-tags-list"></div>
                </div>

                <textarea id="pw-request" class="pw-textarea" placeholder="在此输入初始设定要求..." style="min-height:80px;">${savedState.request || ''}</textarea>
                <button id="pw-btn-gen" class="pw-btn gen"><i class="fa-solid fa-bolt"></i> 生成设定</button>

                <!-- 结果展示区域 -->
                <div id="pw-result-area" style="display:none;">
                    <div style="font-weight:bold; color:#5b8db8; margin-bottom:5px;"><i class="fa-solid fa-list-ul"></i> 设定详情</div>
                    
                    <!-- 正常结果展示容器 -->
                    <div id="pw-main-result-container" style="display:flex; flex-direction:column; flex-grow:1;">
                        <textarea id="pw-result-text" class="pw-result-textarea" placeholder="生成的结果将显示在这里..."></textarea>
                        
                        <!-- 润色工具栏 (在文本框下方) -->
                        <div class="pw-refine-toolbar">
                            <input type="text" id="pw-refine-input" placeholder="输入修改意见 (选中文字点击引用可填入)...">
                            <div class="pw-tool-btn" id="pw-insert-selection" title="将选中的文字添加到修改框"><i class="fa-solid fa-quote-left"></i> 引用</div>
                            <div class="pw-tool-btn" id="pw-btn-refine" title="执行润色"><i class="fa-solid fa-magic"></i> 润色</div>
                            <div class="pw-tool-btn" id="pw-btn-expand" title="全屏编辑"><i class="fa-solid fa-expand"></i></div>
                        </div>
                    </div>

                    <!-- Diff 对比视图 (默认隐藏) -->
                    <div id="pw-diff-container" class="pw-diff-container">
                        <div class="pw-diff-row">
                            <div class="pw-diff-box">
                                <span class="pw-diff-label">修改前</span>
                                <textarea id="pw-diff-old" class="pw-diff-text old" readonly></textarea>
                            </div>
                            <div class="pw-diff-box">
                                <span class="pw-diff-label">修改后 (可微调)</span>
                                <textarea id="pw-diff-new" class="pw-diff-text new"></textarea>
                            </div>
                        </div>
                        <div class="pw-diff-actions">
                            <button id="pw-diff-reject" class="pw-btn danger">放弃修改</button>
                            <button id="pw-diff-accept" class="pw-btn save">确认应用</button>
                        </div>
                    </div>

                    <!-- 底部动作栏 -->
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
        </div>

        <!-- 其他 Tabs 保持不变 -->
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
                        <div class="pw-row pw-api-model-row"><label>Model</label><div style="flex:1; display:flex; gap:5px; width:100%;"><input type="text" id="pw-api-model" class="pw-input" value="${config.indepApiModel}" style="flex:1;"></div></div>
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
    renderWiBooks();
    
    if (savedState.resultText) {
        $('#pw-result-text').val(savedState.resultText);
        $('#pw-result-area').css('display', 'flex'); // Flex display fix
    }
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

    $(document).on('click.pw', '.pw-tab', function() {
        $('.pw-tab').removeClass('active');
        $(this).addClass('active');
        $('.pw-view').removeClass('active');
        const tab = $(this).data('tab');
        $(`#pw-view-${tab}`).addClass('active');
        if(tab === 'history') renderHistoryList(); 
    });

    // 引用选中内容 (追加模式)
    $(document).on('click.pw', '#pw-insert-selection', function() {
        const textarea = document.getElementById('pw-result-text');
        if (textarea) {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const selectedText = textarea.value.substring(start, end).trim();
            
            if (selectedText) {
                const $input = $('#pw-refine-input');
                const currentVal = $input.val();
                // 自动追加换行
                const prefix = currentVal ? (currentVal.endsWith('\n') ? '' : '\n') : '';
                const appendText = `引用: "${selectedText}"`;
                
                $input.val(currentVal + prefix + appendText).focus();
                // 滚动到底部
                $input[0].scrollTop = $input[0].scrollHeight;
            } else {
                toastr.info("请先在上方结果框中划选文字");
            }
        }
    });

    // 全屏编辑 (带返回逻辑)
    $(document).on('click.pw', '#pw-btn-expand', function() {
        saveCurrentState(); // 保存当前状态
        const currentVal = $('#pw-result-text').val();
        
        const popupHtml = `
            <div style="display:flex; flex-direction:column; height:100%;">
                <div style="margin-bottom:10px; opacity:0.7;">全屏编辑模式</div>
                <textarea id="pw-expanded-text" class="pw-textarea" style="flex:1; width:100%; min-height:600px; font-size:1.1em;">${currentVal}</textarea>
            </div>`;
            
        callPopup(popupHtml, 'text', '', { wide: true, large: true, okButton: "应用修改" })
            .then(() => {
                const newVal = $('#pw-expanded-text').val();
                // 更新状态
                const state = loadState();
                state.resultText = newVal;
                saveState(state);
                // 重新打开主界面
                openCreatorPopup();
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
            data: { name: curName, resultText: curText } 
        });
        toastr.success(TEXT.TOAST_SNAPSHOT);
    });

    // 生成
    $(document).on('click.pw', '#pw-btn-gen', async function() {
        const req = $('#pw-request').val();
        if (!req) return toastr.warning("请输入要求");
        const $btn = $(this);
        const oldText = $btn.html();
        $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 生成中...');
        
        try {
            const wiContext = [];
            $('.pw-wi-check:checked').each(function() { wiContext.push(decodeURIComponent($(this).data('content'))); });
            
            const config = { mode: 'initial', request: req, wiContext: wiContext };
            const responseText = await runGeneration(config);
            
            $('#pw-result-text').val(responseText);
            $('#pw-result-area').css('display', 'flex');
            saveCurrentState();
        } catch (e) { toastr.error(`${TEXT.TOAST_GEN_FAIL}: ${e.message}`); } 
        finally { $btn.prop('disabled', false).html(oldText); }
    });

    // 润色 (带 Diff 对比)
    $(document).on('click.pw', '#pw-btn-refine', async function() {
        const refineReq = $('#pw-refine-input').val();
        if (!refineReq) return toastr.warning("请输入润色意见");
        
        const $btn = $(this);
        const oldText = $btn.html();
        $btn.html('<i class="fas fa-spinner fa-spin"></i>'); 
        
        try {
            const currentRawText = $('#pw-result-text').val();
            const config = {
                mode: 'refine',
                request: refineReq,
                currentText: currentRawText
            };
            const newText = await runGeneration(config);

            // 显示 Diff 视图
            $('#pw-diff-old').val(currentRawText);
            $('#pw-diff-new').val(newText);
            
            $('#pw-main-result-container').hide();
            $('#pw-diff-container').css('display', 'flex');
            
            // 绑定 Diff 按钮事件 (临时绑定)
            $('#pw-diff-accept').one('click', () => {
                $('#pw-result-text').val($('#pw-diff-new').val());
                $('#pw-refine-input').val('');
                closeDiff();
                saveCurrentState();
                toastr.success("润色已应用");
            });
            
            $('#pw-diff-reject').one('click', () => {
                closeDiff();
                toastr.info("已放弃修改");
            });

        } catch (e) { toastr.error(`润色失败: ${e.message}`); }
        finally { $btn.html(oldText); }
    });

    function closeDiff() {
        $('#pw-diff-container').hide();
        $('#pw-main-result-container').css('display', 'flex');
        // 解绑事件防止重复
        $('#pw-diff-accept').off('click');
        $('#pw-diff-reject').off('click');
    }

    // 保存并覆盖逻辑
    $(document).on('click.pw', '#pw-btn-apply', async function() {
        const name = $('h5#your_name').text() || "User";
        const finalContent = $('#pw-result-text').val();
        
        if (!finalContent) return toastr.warning("内容为空");

        // 1. 保存 Persona
        try {
            await forceSavePersona(name, finalContent);
            toastr.success(TEXT.TOAST_SAVE_SUCCESS(name));
        } catch (e) { toastr.error(e.message); return; }

        // 2. 世界书保存
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
        $('.popup_close').click();
    });

    $(document).on('click.pw', '#pw-toggle-edit-tags', () => { isEditingTags = !isEditingTags; renderTagsList(); });
    $(document).on('change.pw', '#pw-api-source', function() { $('#pw-indep-settings').toggle($(this).val() === 'independent'); });
    $(document).on('click.pw', '#pw-api-save', () => { saveCurrentState(); toastr.success(TEXT.TOAST_SAVE_API); });
    
    // 历史记录
    $(document).on('input.pw', '#pw-history-search', renderHistoryList);
    $(document).on('click.pw', '#pw-history-search-clear', function() { $('#pw-history-search').val('').trigger('input'); });
    $(document).on('click.pw', '#pw-history-clear-all', function() { if(confirm("清空?")){historyCache=[];saveData();renderHistoryList();} });
    $(document).on('click.pw', '#pw-wi-add', () => { const val = $('#pw-wi-select').val(); if (val && !window.pwExtraBooks.includes(val)) { window.pwExtraBooks.push(val); renderWiBooks(); } });
}

// ============================================================================
// 5. 辅助渲染函数
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
            // [修改] 移除了 click 事件，只保留视觉展示
            const $chip = $(`<div class="pw-tag-chip"><i class="fa-solid fa-tag" style="opacity:0.5; margin-right:4px;"></i><span>${tag.name}</span>${tag.value ? `<span class="pw-tag-val">${tag.value}</span>` : ''}</div>`);
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

window.pwExtraBooks = window.pwExtraBooks || [];
const renderWiBooks = async () => {
    const container = $('#pw-wi-container').empty();
    const baseBooks = await getContextWorldBooks();
    // [修改] 修复世界书合并逻辑，确保正确加载
    window.pwExtraBooks = loadState().localConfig?.extraBooks || [];
    const allBooks = [...new Set([...baseBooks, ...window.pwExtraBooks])];

    if (allBooks.length === 0) {
        container.html('<div style="opacity:0.6; padding:10px; text-align:center;">暂无参考世界书</div>');
        return;
    }

    for (const book of allBooks) {
        const isBound = baseBooks.includes(book);
        const $el = $(`
            <div class="pw-wi-book">
                <div class="pw-wi-header">
                    <span><i class="fa-solid fa-book"></i> ${book} ${isBound ? '<span style="opacity:0.5;font-weight:normal;font-size:0.8em;">(绑定)</span>' : ''}</span>
                    <div>
                        ${!isBound ? '<i class="fa-solid fa-times remove-book" style="color:#ff6b6b;margin-right:10px;" title="移除"></i>' : ''}
                        <i class="fa-solid fa-chevron-down arrow"></i>
                    </div>
                </div>
                <div class="pw-wi-list" data-book="${book}"></div>
            </div>
        `);
        
        $el.find('.remove-book').on('click', (e) => {
            e.stopPropagation();
            window.pwExtraBooks = window.pwExtraBooks.filter(b => b !== book);
            saveCurrentState(); // 保存状态
            renderWiBooks();
        });

        $el.find('.pw-wi-header').on('click', async function() {
            const $list = $el.find('.pw-wi-list');
            const $arrow = $(this).find('.arrow');
            
            if ($list.is(':visible')) {
                $list.slideUp();
                $arrow.removeClass('fa-flip-vertical');
            } else {
                $list.slideDown();
                $arrow.addClass('fa-flip-vertical');
                
                if (!$list.data('loaded')) {
                    $list.html('<div style="padding:10px;text-align:center;"><i class="fas fa-spinner fa-spin"></i></div>');
                    const entries = await getWorldBookEntries(book);
                    $list.empty();
                    
                    if (entries.length === 0) $list.html('<div style="padding:10px;opacity:0.5;">无条目</div>');
                    
                    entries.forEach(entry => {
                        const isChecked = entry.enabled ? 'checked' : '';
                        const $item = $(`
                            <div class="pw-wi-item">
                                <div class="pw-wi-item-row">
                                    <input type="checkbox" class="pw-wi-check" ${isChecked} data-content="${encodeURIComponent(entry.content)}">
                                    <div style="font-weight:bold; font-size:0.9em; flex:1;">${entry.displayName}</div>
                                    <i class="fa-solid fa-eye pw-wi-toggle-icon" title="查看内容"></i>
                                </div>
                                <div class="pw-wi-desc">${entry.content}</div>
                            </div>
                        `);
                        
                        $item.find('.pw-wi-toggle-icon').on('click', function(e) {
                            e.stopPropagation();
                            const $desc = $(this).closest('.pw-wi-item').find('.pw-wi-desc');
                            if($desc.is(':visible')) {
                                $desc.slideUp();
                                $(this).css('color', '');
                            } else {
                                $desc.slideDown();
                                $(this).css('color', '#5b8db8');
                            }
                        });
                        
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

    filtered.forEach((item) => {
        const displayTitle = item.data.name || "未命名";
        const previewText = item.data.resultText || '无内容';
        const $el = $(`<div class="pw-history-item"><div class="pw-hist-main"><div style="font-weight:bold; color:#e0af68;">${displayTitle}</div><div class="pw-hist-meta"><span>${item.timestamp || ''}</span></div><div class="pw-hist-desc">${previewText}</div></div><div class="pw-hist-del-btn"><i class="fa-solid fa-trash"></i></div></div>`);
        
        $el.on('click', function(e) {
            if ($(e.target).closest('.pw-hist-del-btn').length) return;
            $('#pw-request').val(item.request);
            $('#pw-result-text').val(previewText); 
            $('#pw-result-area').css('display', 'flex');
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

// 辅助：手动保存一次状态的函数，给外部调用
function saveCurrentState() {
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
}

jQuery(async () => {
    injectStyles();
    addPersonaButton();
    const observer = new MutationObserver(() => { if ($(`#${BUTTON_ID}`).length === 0 && $('.persona_controls_buttons_block').length > 0) addPersonaButton(); });
    observer.observe(document.body, { childList: true, subtree: true });
    console.log(`${extensionName} v19 loaded.`);
});
