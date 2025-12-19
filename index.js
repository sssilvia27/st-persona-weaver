import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, callPopup, getRequestHeaders } from "../../../../script.js";

// ============================================================================
// 1. 常量与配置
// ============================================================================

const extensionName = "st-persona-weaver";
const STORAGE_KEY_HISTORY = 'pw_history_v18';
const STORAGE_KEY_STATE = 'pw_state_v18'; 
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
    TOAST_NO_CHAR: "请先打开一个角色聊天",
    TOAST_API_OK: "API 连接成功",
    TOAST_API_ERR: "API 连接失败",
    TOAST_SAVE_API: "API 设置已保存",
    TOAST_SNAPSHOT: "已存入历史记录",
    TOAST_GEN_FAIL: "生成失败，请检查 API 设置",
    TOAST_SAVE_SUCCESS: (name) => `Persona "${name}" 已更新！`,
    TOAST_WI_SUCCESS: (book) => `已写入世界书: ${book}`,
    TOAST_WI_FAIL: "写入世界书失败：未选择或未绑定世界书"
};

let historyCache = [];
let tagsCache = [];
let worldInfoCache = {}; 
let availableWorldBooks = []; 
let isEditingTags = false; 
let currentTableData = {}; // 内存暂存 KV 数据

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
    const styleId = 'persona-weaver-css-v18';
    if ($(`#${styleId}`).length) return;
}

// [核心] 暴力写入 Persona
async function forceSavePersona(name, description) {
    const context = getContext();
    if (!context.powerUserSettings.personas) context.powerUserSettings.personas = {};
    context.powerUserSettings.personas[name] = description;

    // 不再处理 Title，仅处理名字和描述
    context.powerUserSettings.persona_selected = name;

    const $nameInput = $('#your_name');
    const $descInput = $('#persona_description');
    
    if ($nameInput.length) {
        $nameInput.val(name).trigger('input').trigger('change');
    }
    if ($descInput.length) {
        $descInput.val(description).trigger('input').trigger('change');
    }

    await saveSettingsDebounced();
    console.log(`[PW] Persona "${name}" updated.`);
    return true;
}

async function loadAvailableWorldBooks() {
    availableWorldBooks = [];
    try {
        const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}) });
        if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data)) {
                availableWorldBooks = data.map(item => item.name || item);
            } else if (data && data.world_names) {
                availableWorldBooks = data.world_names;
            }
        }
    } catch (e) { console.error("[PW] API load failed", e); }
    availableWorldBooks = [...new Set(availableWorldBooks)].filter(x => x).sort();
}

// 获取当前上下文绑定的世界书
async function getContextWorldBooks(extras = []) {
    const context = getContext();
    const books = new Set(extras); 

    const charId = context.characterId;
    if (charId !== undefined && context.characters[charId]) {
        const char = context.characters[charId];
        const data = char.data || char;
        
        const v2Book = data.character_book?.name;
        const extWorld = data.extensions?.world;
        const legacyWorld = data.world;
        const chatWorld = context.chatMetadata?.world_info;

        if (v2Book) books.add(v2Book);
        if (extWorld) books.add(extWorld);
        if (legacyWorld) books.add(legacyWorld);
        if (chatWorld) books.add(chatWorld);
    }
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

async function fetchModels(url, key) {
    try {
        const endpoint = url.includes('v1') ? `${url.replace(/\/$/, '')}/models` : `${url.replace(/\/$/, '')}/v1/models`;
        const response = await fetch(endpoint, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${key}` }
        });
        if (!response.ok) throw new Error("Fetch failed");
        const data = await response.json();
        return (data.data || data).map(m => m.id).sort();
    } catch (e) { console.error(e); return []; }
}

// [核心] 生成与润色逻辑
async function runGeneration(data, apiConfig) {
    const context = getContext();
    const char = context.characters[context.characterId];
    
    // 获取当前名字 (从 DOM 读取最准确)
    const currentName = $('#your_name').text().trim() || "User";

    let wiText = "";
    if (data.wiContext && data.wiContext.length > 0) {
        wiText = `\n[Context from World Info]:\n${data.wiContext.join('\n\n')}\n`;
    }

    let systemPrompt = "";
    
    if (data.mode === 'refine') {
        // === 润色模式 ===
        systemPrompt = `You are a creative writing assistant optimizing a User Persona.
Target Character: ${char.name}
Scenario: ${char.scenario || "None"}
${wiText}

[Current Persona Data (JSON)]:
${JSON.stringify(data.currentTable)}

[User's Refinement Request]:
"${data.request}"

[Task]:
1. Update the JSON data based on the user's request.
2. If the user request is specific to one field (e.g. "change hair to blue"), only change that, but ensure consistency elsewhere.
3. User Name: "${currentName}" (Immutable).

[Response Format]:
Return ONLY a JSON object (Key-Value pairs).
Example: {"Gender": "Female", "Age": "20"}
`;
    } else {
        // === 初次生成模式 ===
        const targetKeys = tagsCache.map(t => t.name).filter(n => n).join(', ');

        systemPrompt = `You are a creative writing assistant creating a User Persona.
Target Character: ${char.name}
Scenario: ${char.scenario || "None"}
${wiText}

[User Request]:
${data.request}

[Task]:
1. Create a detailed Persona for "${currentName}".
2. Provide output as Key-Value pairs.
3. Recommended Keys: ${targetKeys}.

[Response Format]:
Return ONLY a JSON object (Key-Value pairs).
Example: {"Gender": "Male", "Personality": "Stoic"}
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
        responseContent = await context.generateQuietPrompt(systemPrompt, false, false, "System");
    }

    try {
        const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON found in response");
        return JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.error("JSON Parse Error", responseContent);
        throw new Error("Failed to parse AI response as JSON.");
    }
}

// ============================================================================
// 3. UI 渲染与 HTML 模板
// ============================================================================

async function openCreatorPopup() {
    const context = getContext();
    if (context.characterId === undefined) {
        return toastr.warning(TEXT.TOAST_NO_CHAR);
    }

    loadData();
    await loadAvailableWorldBooks();
    const savedState = loadState();
    const config = { ...defaultSettings, ...extension_settings[extensionName], ...savedState.localConfig };
    
    // [修复] 从 #your_name 获取名字
    const currentName = $('#your_name').text().trim() || "User";

    const wiOptions = availableWorldBooks.length > 0 
        ? availableWorldBooks.map(b => `<option value="${b}">${b}</option>`).join('')
        : `<option disabled>未找到世界书</option>`;

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
                
                <!-- 1. 只读名字展示 -->
                <div class="pw-info-display">
                    <div class="pw-info-item">
                        <i class="fa-solid fa-user"></i>
                        <span id="pw-display-name">${currentName}</span>
                    </div>
                </div>

                <!-- 2. 输入区域 -->
                <div>
                    <div class="pw-tags-header">
                        <span class="pw-tags-label">基础设定 (点击标签填入)</span>
                        <span class="pw-tags-edit-toggle" id="pw-toggle-edit-tags">编辑标签</span>
                    </div>
                    <div class="pw-tags-container" id="pw-tags-list"></div>
                </div>

                <textarea id="pw-request" class="pw-textarea" placeholder="在此输入设定要求，例如：'20岁女大学生，性格开朗'..." style="min-height:80px;">${savedState.request || ''}</textarea>
                
                <div class="pw-editor-tools">
                    <div class="pw-mini-btn" id="pw-clear"><i class="fa-solid fa-eraser"></i> 清空</div>
                    <div class="pw-mini-btn" id="pw-snapshot"><i class="fa-solid fa-save"></i> 存入历史</div>
                </div>

                <div style="text-align:right;">
                    <button id="pw-btn-gen" class="pw-btn gen"><i class="fa-solid fa-bolt"></i> 生成设定</button>
                </div>

                <!-- 3. KV 列表编辑器 -->
                <div id="pw-result-area" style="display:none; margin-top:10px;">
                    <div style="font-weight:bold; color:#5b8db8; margin-bottom:5px;">
                        <i class="fa-solid fa-list-check"></i> 设定详情 (点击直接修改)
                    </div>
                    
                    <div id="pw-kv-list" class="pw-kv-container">
                        <!-- JS 动态生成 KV Rows -->
                    </div>
                    <div id="pw-kv-add" class="pw-kv-add-btn"><i class="fa-solid fa-plus"></i> 添加新条目</div>

                    <div class="pw-refine-box">
                        <input type="text" id="pw-refine-input" class="pw-input" placeholder="输入润色意见 (例如: 把发色改成银色)..." style="flex:1;">
                        <button id="pw-btn-refine" class="pw-btn primary" style="width:auto;"><i class="fa-solid fa-magic"></i> 润色</button>
                    </div>

                    <div style="margin-top:10px; background:rgba(0,0,0,0.1); padding:10px; border-radius:8px; display:flex; align-items:center; gap:10px;">
                        <div style="display:flex; align-items:center; gap:5px;">
                            <input type="checkbox" id="pw-wi-toggle" checked>
                            <span style="font-size:0.9em; font-weight:bold;">同步写入世界书</span>
                        </div>
                        <button id="pw-btn-apply" class="pw-btn save"><i class="fa-solid fa-check"></i> 保存并生效</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- Context Tab -->
        <div id="pw-view-context" class="pw-view">
            <div class="pw-scroll-area">
                <div class="pw-card-section">
                    <div class="pw-wi-controls">
                        <select id="pw-wi-select" class="pw-input pw-wi-select"><option value="">-- 添加参考/目标世界书 --</option>${wiOptions}</select>
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
                    <div class="pw-row"><label>API 来源</label><select id="pw-api-source" class="pw-input" style="flex:1;"><option value="main" ${config.apiSource === 'main'?'selected':''}>使用主 API</option><option value="independent" ${config.apiSource === 'independent'?'selected':''}>独立 API</option></select></div>
                    <div id="pw-indep-settings" style="display:${config.apiSource === 'independent' ? 'flex' : 'none'}; flex-direction:column; gap:15px;">
                        <div class="pw-row"><label>URL</label><input type="text" id="pw-api-url" class="pw-input" value="${config.indepApiUrl}" placeholder="https://api.openai.com/v1" style="flex:1;"></div>
                        <div class="pw-row"><label>Key</label><input type="password" id="pw-api-key" class="pw-input" value="${config.indepApiKey}" style="flex:1;"></div>
                        <div class="pw-row pw-api-model-row"><label>Model</label><div style="flex:1; display:flex; gap:5px; width:100%;"><input type="text" id="pw-api-model" class="pw-input" value="${config.indepApiModel}" list="pw-model-list" style="flex:1;"><datalist id="pw-model-list"></datalist><button id="pw-api-fetch" class="pw-btn primary pw-api-fetch-btn"><i class="fa-solid fa-cloud-download-alt"></i></button></div></div>
                    </div>
                    <div style="text-align:right;"><button id="pw-api-save" class="pw-btn primary" style="width:auto;"><i class="fa-solid fa-save"></i> 保存设置</button></div>
                </div>
            </div>
        </div>

        <!-- History Tab -->
        <div id="pw-view-history" class="pw-view">
            <div class="pw-scroll-area">
                <div class="pw-search-box"><input type="text" id="pw-history-search" class="pw-input pw-search-input" placeholder="🔍 搜索历史..."><i class="fa-solid fa-times pw-search-clear" id="pw-history-search-clear"></i></div>
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
    
    // 恢复表格
    if (savedState.tableData && Object.keys(savedState.tableData).length > 0) {
        currentTableData = savedState.tableData;
        renderKVList(currentTableData);
        $('#pw-result-area').show();
    }
}

// ============================================================================
// 4. 事件绑定
// ============================================================================

function bindEvents() {
    $(document).off('.pw');

    const saveCurrentState = () => {
        // 保存前先抓取最新的 KV 数据
        scrapeKVData();
        saveState({
            request: $('#pw-request').val(),
            tableData: currentTableData,
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
    $(document).on('input.pw change.pw', '#pw-request, .pw-kv-val, .pw-kv-key, .pw-input', saveCurrentState);

    // Tab 切换
    $(document).on('click.pw', '.pw-tab', function() {
        $('.pw-tab').removeClass('active');
        $(this).addClass('active');
        $('.pw-view').removeClass('active');
        const tab = $(this).data('tab');
        $(`#pw-view-${tab}`).addClass('active');
        if(tab === 'history') renderHistoryList(); 
    });

    // 清空与快照
    $(document).on('click.pw', '#pw-clear', function() {
        if(confirm("清空输入内容？")) {
            $('#pw-request').val('');
            $('#pw-result-area').hide();
            currentTableData = {};
            $('#pw-kv-list').empty();
            saveCurrentState();
        }
    });

    $(document).on('click.pw', '#pw-snapshot', function() {
        scrapeKVData();
        const curName = $('#pw-display-name').text();
        if (Object.keys(currentTableData).length === 0) return;
        
        saveHistory({ 
            request: $('#pw-request').val() || "无请求内容", 
            timestamp: new Date().toLocaleString(),
            targetChar: getContext().characters[getContext().characterId]?.name || "未知",
            data: { name: curName, tableData: currentTableData } 
        });
        toastr.success(TEXT.TOAST_SNAPSHOT);
    });

    // --- 1. 生成逻辑 ---
    $(document).on('click.pw', '#pw-btn-gen', async function() {
        const req = $('#pw-request').val();
        if (!req) return toastr.warning("请输入一些设定要求");

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

            const jsonData = await runGeneration(config, config);
            currentTableData = jsonData;
            renderKVList(currentTableData);
            
            $('#pw-result-area').fadeIn();
            saveCurrentState();

        } catch (e) {
            toastr.error(`${TEXT.TOAST_GEN_FAIL}: ${e.message}`);
        } finally {
            $btn.prop('disabled', false).html(oldText);
        }
    });

    // --- 2. 润色逻辑 ---
    $(document).on('click.pw', '#pw-btn-refine', async function() {
        const refineReq = $('#pw-refine-input').val();
        if (!refineReq) return toastr.warning("请输入润色意见");

        scrapeKVData(); // 获取当前表格的最新状态

        const $btn = $(this);
        const oldText = $btn.html();
        $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 润色中...');

        try {
            const config = {
                mode: 'refine',
                request: refineReq,
                currentTable: currentTableData, 
                apiSource: $('#pw-api-source').val(),
                indepApiUrl: $('#pw-api-url').val(),
                indepApiKey: $('#pw-api-key').val(),
                indepApiModel: $('#pw-api-model').val()
            };

            const jsonData = await runGeneration(config, config);
            currentTableData = jsonData;
            renderKVList(currentTableData);
            
            $('#pw-refine-input').val(''); 
            saveCurrentState();
            toastr.success("润色完成");

        } catch (e) {
            toastr.error(`润色失败: ${e.message}`);
        } finally {
            $btn.prop('disabled', false).html(oldText);
        }
    });

    // --- 3. 保存并应用 ---
    $(document).on('click.pw', '#pw-btn-apply', async function() {
        scrapeKVData();
        const name = $('#pw-display-name').text();
        
        // 格式化为键值对文本
        const finalContent = Object.entries(currentTableData)
            .map(([k, v]) => `${k}: ${v}`).join('\n');

        // 1. 保存到 Persona
        try {
            await forceSavePersona(name, finalContent);
            toastr.success(TEXT.TOAST_SAVE_SUCCESS(name));
        } catch (e) { toastr.error(e.message); return; }

        // 2. 保存到世界书
        if ($('#pw-wi-toggle').is(':checked')) {
            await saveToWorldInfo(name, finalContent);
        }

        saveHistory({
            request: $('#pw-request').val(),
            timestamp: new Date().toLocaleString(),
            targetChar: getContext().characters[getContext().characterId]?.name || "未知",
            data: { name: name, tableData: currentTableData } 
        });

        $('.popup_close').click();
    });

    // KV 列表操作
    $(document).on('click.pw', '.pw-kv-del', function() {
        $(this).closest('.pw-kv-row').remove();
        saveCurrentState();
    });
    
    $(document).on('click.pw', '#pw-kv-add', function() {
        $('#pw-kv-list').append(`
            <div class="pw-kv-row">
                <input class="pw-kv-key" placeholder="新属性">
                <input class="pw-kv-val" placeholder="描述">
                <i class="fa-solid fa-trash pw-kv-action pw-kv-del"></i>
            </div>
        `);
        // 滚动到底部
        const container = document.getElementById('pw-kv-list');
        container.scrollTop = container.scrollHeight;
    });

    // Tag 开关
    $(document).on('click.pw', '#pw-toggle-edit-tags', () => {
        isEditingTags = !isEditingTags;
        renderTagsList();
    });

    // API & WI Handlers (保持不变)
    $(document).on('change.pw', '#pw-api-source', function() { $('#pw-indep-settings').toggle($(this).val() === 'independent'); });
    $(document).on('click.pw', '#pw-api-fetch', async function() { /* ... */ }); 
    $(document).on('click.pw', '#pw-api-save', () => { saveCurrentState(); toastr.success(TEXT.TOAST_SAVE_API); });
    
    $(document).on('click.pw', '#pw-wi-add', () => {
        const val = $('#pw-wi-select').val();
        if (val && !window.pwExtraBooks.includes(val)) {
            window.pwExtraBooks.push(val);
            renderWiBooks();
        }
    });
    
    // History Handlers
    $(document).on('input.pw', '#pw-history-search', renderHistoryList);
    $(document).on('click.pw', '#pw-history-search-clear', () => $('#pw-history-search').val('').trigger('input'));
    $(document).on('click.pw', '#pw-history-clear-all', () => { if(confirm("清空?")){historyCache=[];saveData();renderHistoryList();} });
}

// ============================================================================
// 5. 辅助功能 (KV渲染、WI保存)
// ============================================================================

// [新增] 渲染 KV 列表
function renderKVList(data) {
    const $container = $('#pw-kv-list').empty();
    Object.entries(data).forEach(([key, value]) => {
        $container.append(`
            <div class="pw-kv-row">
                <input class="pw-kv-key" value="${key}">
                <input class="pw-kv-val" value="${value}">
                <i class="fa-solid fa-trash pw-kv-action pw-kv-del"></i>
            </div>
        `);
    });
}

// [新增] 从 DOM 抓取 KV 数据到 currentTableData
function scrapeKVData() {
    const newData = {};
    $('.pw-kv-row').each(function() {
        const k = $(this).find('.pw-kv-key').val().trim();
        const v = $(this).find('.pw-kv-val').val().trim();
        if (k) newData[k] = v;
    });
    currentTableData = newData;
}

// [修复] 世界书保存逻辑
async function saveToWorldInfo(name, content) {
    const context = getContext();
    const boundBooks = await getContextWorldBooks();
    
    // 优先使用用户在下拉框里手动添加的第一个，如果没有才用绑定的
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
                const ids = Object.keys(d.entries).map(Number);
                const newId = ids.length ? Math.max(...ids) + 1 : 0;
                
                const keys = [name, "User"];

                d.entries[newId] = { uid: newId, key: keys, content: content, comment: `User: ${name}`, enabled: true, selective: true };
                await fetch('/api/worldinfo/edit', { method: 'POST', headers: h, body: JSON.stringify({ name: targetBook, data: d }) });
                toastr.success(TEXT.TOAST_WI_SUCCESS(targetBook));
                if (context.updateWorldInfoList) context.updateWorldInfoList();
            }
        } catch(e) { console.error(e); }
    } else {
        toastr.warning(TEXT.TOAST_WI_FAIL);
    }
}

// History 渲染
const renderHistoryList = () => {
    loadData();
    const $list = $('#pw-history-list').empty();
    const search = $('#pw-history-search').val().toLowerCase();

    const filtered = historyCache.filter(item => {
        if (!search) return true;
        const name = (item.data.name || "").toLowerCase();
        return name.includes(search);
    });

    if (filtered.length === 0) {
        $list.html('<div style="text-align:center; opacity:0.6; padding:20px;">暂无历史记录</div>');
        return;
    }

    filtered.forEach((item, index) => {
        const displayTitle = item.data.name || "未命名";
        // 预览内容
        let previewText = "";
        if (item.data.tableData) {
            previewText = Object.entries(item.data.tableData).map(([k,v])=>`${k}: ${v}`).join('; ');
        } else {
            previewText = item.data.description || "无内容";
        }

        const $el = $(`
            <div class="pw-history-item">
                <div class="pw-hist-main">
                    <div style="font-weight:bold; color:#e0af68;">${displayTitle}</div>
                    <div class="pw-hist-meta"><span>${item.timestamp || ''}</span></div>
                    <div class="pw-hist-desc">${previewText}</div>
                </div>
                <div class="pw-hist-del-btn"><i class="fa-solid fa-trash"></i></div>
            </div>
        `);

        $el.on('click', function(e) {
            if ($(e.target).closest('.pw-hist-del-btn').length) return;
            $('#pw-request').val(item.request);
            
            if (item.data.tableData) {
                currentTableData = item.data.tableData;
                renderKVList(currentTableData);
                $('#pw-result-area').show();
            }
            $('.pw-tab[data-tab="editor"]').click();
        });

        $el.find('.pw-hist-del-btn').on('click', function(e) {
            e.stopPropagation();
            if(confirm(`删除?`)) {
                historyCache.splice(historyCache.indexOf(item), 1);
                saveData();
                renderHistoryList();
            }
        });

        $list.append($el);
    });
};

// ... (Tag 渲染 & 初始化保持不变) ...
const renderTagsList = () => { /* ... 复用之前的代码 ... */ 
    const $container = $('#pw-tags-list').empty();
    const $toggleBtn = $('#pw-toggle-edit-tags');
    $toggleBtn.text(isEditingTags ? '取消编辑' : '编辑标签');
    $toggleBtn.css('color', isEditingTags ? '#ff6b6b' : '#5b8db8');
    tagsCache.forEach((tag, index) => {
        if (isEditingTags) {
            const $row = $(`<div class="pw-tag-edit-row"><input class="pw-tag-edit-input t-name" value="${tag.name}"><input class="pw-tag-edit-input t-val" value="${tag.value}"><div class="pw-tag-del-btn"><i class="fa-solid fa-trash"></i></div></div>`);
            $row.find('input').on('input', function() { tag.name = $row.find('.t-name').val(); tag.value = $row.find('.t-val').val(); saveData(); });
            $row.find('.pw-tag-del-btn').on('click', () => { if (confirm(`删除?`)) { tagsCache.splice(index, 1); saveData(); renderTagsList(); } });
            $container.append($row);
        } else {
            const $chip = $(`<div class="pw-tag-chip"><i class="fa-solid fa-tag" style="opacity:0.5; margin-right:4px;"></i><span>${tag.name}</span>${tag.value ? `<span class="pw-tag-val">${tag.value}</span>` : ''}</div>`);
            $chip.on('click', () => {
                const $text = $('#pw-request');
                const cur = $text.val();
                const insert = tag.value ? `${tag.name}: ${tag.value}` : `${tag.name}: `;
                const prefix = (cur && !cur.endsWith('\n')) ? '\n' : '';
                $text.val(cur + prefix + insert).focus();
                $text[0].scrollTop = $text[0].scrollHeight;
                saveData();
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
    const observer = new MutationObserver(() => {
        if ($(`#${BUTTON_ID}`).length === 0 && $('.persona_controls_buttons_block').length > 0) {
            addPersonaButton();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    console.log(`${extensionName} v18 loaded.`);
});
