import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, callPopup, getRequestHeaders } from "../../../../script.js";

// ============================================================================
// 1. 常量与配置
// ============================================================================

const extensionName = "st-persona-weaver";
const STORAGE_KEY_HISTORY = 'pw_history_v20'; // 更新版本号以重置旧的不兼容数据
const STORAGE_KEY_STATE = 'pw_state_v20'; 
const STORAGE_KEY_TAGS = 'pw_tags_v12';
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
    TOAST_NO_CHAR: "请先打开一个角色聊天",
    TOAST_SAVE_SUCCESS: (name) => `Persona "${name}" 已保存！`,
    TOAST_WI_SUCCESS: (book) => `已写入世界书: ${book}`,
    TOAST_WI_FAIL: "未找到可写入的世界书，请在上方下拉框选择一本。",
    TOAST_API_OK: "API 连接成功",
    TOAST_API_ERR: "API 连接失败",
    TOAST_SNAPSHOT: "已存入历史记录"
};

let historyCache = [];
let tagsCache = [];
let worldInfoCache = {}; 
let availableWorldBooks = []; 
let isEditingTags = false; 
// [核心] 暂存当前的 Key-Value 数据
let currentDataList = {}; 

// ============================================================================
// 2. 基础功能 (存储、样式、状态)
// ============================================================================

function loadData() {
    try { historyCache = JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY)) || []; } catch { historyCache = []; }
    try { tagsCache = JSON.parse(localStorage.getItem(STORAGE_KEY_TAGS)) || defaultTags; } catch { tagsCache = defaultTags; }
}
function saveData() {
    localStorage.setItem(STORAGE_KEY_TAGS, JSON.stringify(tagsCache));
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(historyCache));
}
function saveState(data) { localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(data)); }
function loadState() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY_STATE)) || {}; } catch { return {}; } }
function injectStyles() { if (!$(`#persona-weaver-css-v18`).length) return; } // CSS 由 style.css 处理，这里仅留接口

// [核心修复] 获取当前 Persona 名字 (优先从 UI 获取，这是最准的)
function getCurrentPersonaName() {
    const $input = $('#your_name');
    if ($input.length && $input.val()) return $input.val();
    
    // 如果 UI 没加载，尝试从 Context 获取
    const context = getContext();
    return context.name1 || "User";
}

// [核心] 暴力保存 Persona 到系统
async function forceSavePersona(name, description) {
    const context = getContext();
    // 1. 更新内存
    if (!context.powerUserSettings.personas) context.powerUserSettings.personas = {};
    context.powerUserSettings.personas[name] = description;
    context.powerUserSettings.persona_selected = name;

    // 2. 更新 UI (如果存在)
    const $nameInput = $('#your_name');
    const $descInput = $('#persona_description');
    if ($nameInput.length) $nameInput.val(name).trigger('input').trigger('change');
    if ($descInput.length) $descInput.val(description).trigger('input').trigger('change');

    // 3. 触发系统保存
    await saveSettingsDebounced();
}

// ============================================================================
// 3. 核心逻辑 (生成、润色、世界书)
// ============================================================================

// 生成/润色 API 调用
async function runGeneration(data, apiConfig) {
    const context = getContext();
    const char = context.characters[context.characterId];
    const currentName = getCurrentPersonaName();

    let wiText = "";
    if (data.wiContext && data.wiContext.length > 0) {
        wiText = `\n[Context from World Info]:\n${data.wiContext.join('\n\n')}\n`;
    }

    let systemPrompt = "";
    
    if (data.mode === 'refine') {
        // === 润色模式 ===
        // 将当前的 JSON 数据发给 AI，要求修改
        systemPrompt = `You are a creative writing assistant optimizing a User Persona.
Target Character: ${char.name}
${wiText}

[Current Persona Data]:
${JSON.stringify(data.currentData, null, 2)}

[Refinement Request]:
"${data.request}"

[Task]:
1. Update the Data based on request.
2. Return strictly a JSON object (Key-Value pairs).
3. Ensure consistency.
4. Do NOT include 'Name' key.
`;
    } else {
        // === 初次生成模式 ===
        const targetKeys = tagsCache.map(t => t.name).filter(n => n).join(', ');
        systemPrompt = `You are a creative writing assistant creating a User Persona.
Target Character: ${char.name}
${wiText}

[Request]:
${data.request}

[Task]:
1. Create a detailed persona for "${currentName}".
2. Return strictly a JSON object (Key-Value pairs).
3. Recommended Keys: ${targetKeys} (You can add more).
4. Do NOT include 'Name' key.
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
        if (!res.ok) throw new Error("API Error");
        const json = await res.json();
        responseContent = json.choices[0].message.content;
    } else {
        responseContent = await context.generateQuietPrompt(systemPrompt, false, false, "System");
    }

    // 解析 JSON
    const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    return JSON.parse(jsonMatch[0]);
}

// [核心修复] 写入世界书
async function saveToWorldInfo(name, content) {
    const context = getContext();
    
    // 1. 优先：尝试查找角色绑定的书
    let targetBook = null;
    const char = context.characters[context.characterId];
    if (char) {
        const data = char.data || char;
        targetBook = data.character_book?.name || data.extensions?.world || data.world;
    }
    
    // 2. 兜底：如果没绑定，使用当前工具栏里选中的书
    if (!targetBook) {
        const selectedInUi = $('#pw-wi-select').val();
        if (selectedInUi) targetBook = selectedInUi;
        // 3. 再兜底：使用已加载列表的第一本
        else if (window.pwExtraBooks && window.pwExtraBooks.length > 0) targetBook = window.pwExtraBooks[0];
    }

    if (!targetBook) {
        toastr.warning(TEXT.TOAST_WI_FAIL);
        return;
    }

    try {
        const h = getRequestHeaders();
        // 获取书籍内容
        const r = await fetch('/api/worldinfo/get', { method: 'POST', headers: h, body: JSON.stringify({ name: targetBook }) });
        if (r.ok) {
            const d = await r.json();
            if (!d.entries) d.entries = {};
            
            // 查找是否已存在该用户的条目 (通过 comment 标记)
            const entriesArr = Object.values(d.entries);
            let existingEntry = entriesArr.find(e => e.comment === `User: ${name}`);
            
            // 决定 UID
            let uidToUse = existingEntry ? existingEntry.uid : (Object.keys(d.entries).length > 0 ? Math.max(...Object.keys(d.entries).map(Number)) + 1 : 0);

            // 写入/更新条目
            d.entries[uidToUse] = { 
                uid: uidToUse, 
                key: [name, "User"], 
                content: content, // 这里写入的是格式化后的文本
                comment: `User: ${name}`, 
                enabled: true, 
                selective: true 
            };
            
            await fetch('/api/worldinfo/edit', { method: 'POST', headers: h, body: JSON.stringify({ name: targetBook, data: d }) });
            toastr.success(TEXT.TOAST_WI_SUCCESS(targetBook));
            if (context.updateWorldInfoList) context.updateWorldInfoList();
        }
    } catch(e) { console.error(e); }
}

// ============================================================================
// 4. UI 渲染 (List Editor)
// ============================================================================

// 渲染可编辑的属性列表 (Key | Input)
function renderEditorList(data) {
    const $container = $('#pw-result-list-container').empty();
    
    Object.entries(data).forEach(([key, val]) => {
        const $row = $(`
            <div class="pw-result-row">
                <div class="pw-key-label">${key}</div>
                <input type="text" class="pw-val-input" value="${val}" data-key="${key}">
            </div>
        `);
        // 绑定输入事件以便实时保存状态
        $row.find('input').on('input', () => {
            // 这里不需要实时写回 currentDataList，saveCurrentState 会处理
        });
        $container.append($row);
    });
}

// 从 DOM 抓取最新数据回内存
function getEditorData() {
    const newData = {};
    $('.pw-val-input').each(function() {
        const k = $(this).data('key');
        const v = $(this).val();
        newData[k] = v;
    });
    return newData;
}

// 加载 API 列表
async function fetchModels(url, key) {
    try {
        const endpoint = url.includes('v1') ? `${url.replace(/\/$/, '')}/models` : `${url.replace(/\/$/, '')}/v1/models`;
        const response = await fetch(endpoint, { method: 'GET', headers: { 'Authorization': `Bearer ${key}` } });
        if (!response.ok) throw new Error("Fetch failed");
        const data = await response.json();
        return (data.data || data).map(m => m.id).sort();
    } catch (e) { console.error(e); return []; }
}

async function openCreatorPopup() {
    const context = getContext();
    if (context.characterId === undefined) return toastr.warning(TEXT.TOAST_NO_CHAR);

    loadData();
    // 刷新世界书列表
    try {
        const r = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}) });
        if(r.ok) {
            const d = await r.json();
            availableWorldBooks = (Array.isArray(d) ? d : d.world_names).map(x => x.name || x).sort();
        }
    } catch {}

    const savedState = loadState();
    const config = { ...defaultSettings, ...extension_settings[extensionName], ...savedState.localConfig };
    const currentName = getCurrentPersonaName();

    const wiOptions = availableWorldBooks.map(b => `<option value="${b}">${b}</option>`).join('');

    // --- HTML 模板 ---
    const html = `
    <div class="pw-wrapper">
        <div class="pw-header">
            <div class="pw-top-bar"><div class="pw-title"><i class="fa-solid fa-wand-magic-sparkles" style="color:#e0af68;"></i> 设定编织者 Pro</div></div>
            <div class="pw-tabs">
                <div class="pw-tab active" data-tab="editor"><i class="fa-solid fa-pen-to-square"></i> 编辑</div>
                <div class="pw-tab" data-tab="context"><i class="fa-solid fa-book"></i> 世界书</div>
                <div class="pw-tab" data-tab="api"><i class="fa-solid fa-gear"></i> API</div>
                <div class="pw-tab" data-tab="history"><i class="fa-solid fa-clock-rotate-left"></i> 历史</div>
            </div>
        </div>

        <div id="pw-view-editor" class="pw-view active">
            <div class="pw-scroll-area">
                <!-- 只读显示名字 -->
                <div class="pw-info-display"><i class="fa-solid fa-user"></i>&nbsp; ${currentName}</div>

                <!-- 标签与请求 -->
                <div>
                    <div class="pw-tags-header">
                        <span style="opacity:0.7;font-weight:bold;">基础设定</span>
                        <span class="pw-tags-edit-toggle" id="pw-toggle-edit-tags" style="cursor:pointer;color:#5b8db8;">编辑标签</span>
                    </div>
                    <div class="pw-tags-container" id="pw-tags-list"></div>
                </div>

                <textarea id="pw-request" class="pw-textarea" placeholder="输入设定要求 (例如: '22岁, 大学生, 性格内向')..." style="min-height:60px;">${savedState.request || ''}</textarea>
                
                <!-- 工具栏 -->
                <div class="pw-editor-tools">
                    <div class="pw-mini-btn" id="pw-clear"><i class="fa-solid fa-eraser"></i> 清空</div>
                    <div class="pw-mini-btn" id="pw-snapshot"><i class="fa-solid fa-save"></i> 存历史</div>
                    <button id="pw-btn-gen" class="pw-btn gen" style="width:auto; padding:6px 15px;"><i class="fa-solid fa-bolt"></i> 生成</button>
                </div>

                <!-- 结果区域 (列表编辑) -->
                <div id="pw-result-area" style="display:none; margin-top:15px; border-top:2px solid var(--SmartThemeBorderColor); padding-top:10px;">
                    <div style="font-weight:bold; color:#5b8db8; margin-bottom:8px;"><i class="fa-solid fa-list"></i> 设定详情 (点击右侧直接修改)</div>
                    
                    <div id="pw-result-list-container" class="pw-result-list"></div>

                    <div class="pw-refine-box">
                        <input type="text" id="pw-refine-input" class="pw-input" placeholder="输入润色意见 (例如: '把性格改得更病娇一点')..." style="flex:1;">
                        <button id="pw-btn-refine" class="pw-btn primary" style="width:auto;"><i class="fa-solid fa-magic"></i> 润色</button>
                    </div>

                    <div style="margin-top:10px; padding:10px; background:rgba(0,0,0,0.1); border-radius:6px; display:flex; justify-content:space-between; align-items:center;">
                        <div style="display:flex; align-items:center; gap:5px;">
                            <input type="checkbox" id="pw-wi-toggle" checked> <span style="font-size:0.9em;">同步写入世界书</span>
                        </div>
                        <button id="pw-btn-apply" class="pw-btn save" style="width:auto;"><i class="fa-solid fa-check"></i> 保存并生效</button>
                    </div>
                </div>
            </div>
        </div>

        <div id="pw-view-context" class="pw-view"><div class="pw-scroll-area"><div style="padding:10px;background:rgba(0,0,0,0.2);border-radius:6px;margin-bottom:10px;"><select id="pw-wi-select" class="pw-input" style="width:100%;margin-bottom:5px;"><option value="">-- 选择世界书 --</option>${wiOptions}</select></div><div id="pw-wi-container"></div></div></div>
        
        <div id="pw-view-api" class="pw-view"><div class="pw-scroll-area"><div style="padding:10px;"><label>API Source</label><select id="pw-api-source" class="pw-input" style="width:100%;margin-bottom:10px;"><option value="main" ${config.apiSource==='main'?'selected':''}>Main API</option><option value="independent" ${config.apiSource==='independent'?'selected':''}>Independent</option></select><div id="pw-indep-settings" style="display:${config.apiSource==='independent'?'block':'none'}"><input id="pw-api-url" class="pw-input" placeholder="URL" value="${config.indepApiUrl}" style="margin-bottom:5px;width:100%;"><input id="pw-api-key" type="password" class="pw-input" placeholder="Key" value="${config.indepApiKey}" style="margin-bottom:5px;width:100%;"><input id="pw-api-model" class="pw-input" placeholder="Model" value="${config.indepApiModel}" style="width:100%;"></div></div></div></div>
        
        <div id="pw-view-history" class="pw-view"><div class="pw-scroll-area"><div id="pw-history-list"></div><button id="pw-history-clear-all" class="pw-btn danger" style="margin-top:10px;">清空历史</button></div></div>
    </div>`;

    callPopup(html, 'text', '', { wide: true, large: true, okButton: "关闭" });
    
    bindEvents();
    renderTagsList();
    
    // 恢复状态
    if (savedState.currentData && Object.keys(savedState.currentData).length > 0) {
        currentDataList = savedState.currentData;
        renderEditorList(currentDataList);
        $('#pw-result-area').show();
    }
}

// ============================================================================
// 5. 事件绑定 (使用 document 委托确保稳定性)
// ============================================================================

function bindEvents() {
    $(document).off('.pw');

    // 自动保存状态
    const saveCurrentState = () => {
        // 如果结果区域是可见的，说明用户可能修改了列表，同步到内存
        if ($('#pw-result-area').is(':visible')) {
            currentDataList = getEditorData();
        }
        saveState({
            request: $('#pw-request').val(),
            currentData: currentDataList,
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
    $(document).on('input.pw change.pw', '#pw-request, .pw-val-input, .pw-input', saveCurrentState);

    // Tab 切换
    $(document).on('click.pw', '.pw-tab', function() {
        $('.pw-tab').removeClass('active');
        $(this).addClass('active');
        $('.pw-view').removeClass('active');
        $(`#pw-view-${$(this).data('tab')}`).addClass('active');
        if($(this).data('tab') === 'history') renderHistoryList();
    });

    // 清空
    $(document).on('click.pw', '#pw-clear', function() {
        if(confirm("确定清空？")) {
            $('#pw-request').val('');
            $('#pw-result-area').hide();
            currentDataList = {};
            saveCurrentState();
        }
    });

    // 快照 (修复：确保获取最新数据)
    $(document).on('click.pw', '#pw-snapshot', function() {
        if ($('#pw-result-area').is(':hidden')) return toastr.warning("没有可保存的内容");
        const data = getEditorData(); // 获取当前UI上的数据
        saveHistory({
            timestamp: new Date().toLocaleString(),
            name: getCurrentPersonaName(),
            data: data // 存 JSON 对象
        });
        toastr.success(TEXT.TOAST_SNAPSHOT);
    });

    // 生成
    $(document).on('click.pw', '#pw-btn-gen', async function() {
        const req = $('#pw-request').val();
        if (!req) return toastr.warning("请输入设定要求");
        const $btn = $(this);
        const oldHtml = $btn.html();
        $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i>');

        try {
            const config = {
                mode: 'initial',
                request: req,
                apiSource: $('#pw-api-source').val(),
                indepApiUrl: $('#pw-api-url').val(),
                indepApiKey: $('#pw-api-key').val(),
                indepApiModel: $('#pw-api-model').val()
            };
            const json = await runGeneration(config, config);
            currentDataList = json;
            renderEditorList(json);
            $('#pw-result-area').fadeIn();
            saveCurrentState();
        } catch (e) { toastr.error(e.message); } 
        finally { $btn.prop('disabled', false).html(oldHtml); }
    });

    // 润色
    $(document).on('click.pw', '#pw-btn-refine', async function() {
        const req = $('#pw-refine-input').val();
        if (!req) return;
        const $btn = $(this);
        const oldHtml = $btn.html();
        $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i>');

        try {
            // 先获取用户刚才手动修改过的数据
            currentDataList = getEditorData();

            const config = {
                mode: 'refine',
                request: req,
                currentData: currentDataList, 
                apiSource: $('#pw-api-source').val(),
                indepApiUrl: $('#pw-api-url').val(),
                indepApiKey: $('#pw-api-key').val(),
                indepApiModel: $('#pw-api-model').val()
            };
            const json = await runGeneration(config, config);
            currentDataList = json;
            renderEditorList(json);
            $('#pw-refine-input').val('');
            saveCurrentState();
        } catch (e) { toastr.error(e.message); } 
        finally { $btn.prop('disabled', false).html(oldHtml); }
    });

    // 保存并应用
    $(document).on('click.pw', '#pw-btn-apply', async function() {
        // 1. 获取数据并格式化
        const data = getEditorData();
        const content = Object.entries(data).map(([k,v]) => `${k}: ${v}`).join('\n');
        const name = getCurrentPersonaName();

        // 2. 保存到 Persona
        try {
            await forceSavePersona(name, content);
            toastr.success(TEXT.TOAST_SAVE_SUCCESS(name));
        } catch (e) { toastr.error(e.message); return; }

        // 3. 保存到世界书
        if ($('#pw-wi-toggle').is(':checked')) {
            await saveToWorldInfo(name, content);
        }
        
        // 4. 自动保存一份到历史
        saveHistory({
            timestamp: new Date().toLocaleString(),
            name: name,
            data: data
        });

        $('.popup_close').click();
    });

    // 其他事件
    $(document).on('click.pw', '#pw-toggle-edit-tags', () => { isEditingTags = !isEditingTags; renderTagsList(); });
    $(document).on('click.pw', '#pw-history-clear-all', () => { historyCache=[]; saveData(); renderHistoryList(); });
    $(document).on('change.pw', '#pw-api-source', function() { $('#pw-indep-settings').toggle($(this).val() === 'independent'); });
    $(document).on('click.pw', '#pw-api-fetch', async function() { /*...省略重复代码...*/ }); 
    $(document).on('click.pw', '#pw-api-save', () => { saveCurrentState(); toastr.success(TEXT.TOAST_SAVE_API); });
    $(document).on('click.pw', '#pw-wi-add', () => { 
        const val = $('#pw-wi-select').val(); 
        if (val && !window.pwExtraBooks.includes(val)) { window.pwExtraBooks.push(val); renderWiBooks(); } 
    });
}

// ============================================================================
// 6. 组件渲染 (Tag, History, WI)
// ============================================================================

const renderTagsList = () => {
    const $c = $('#pw-tags-list').empty();
    $('#pw-toggle-edit-tags').text(isEditingTags ? '完成' : '编辑');
    tagsCache.forEach((t, i) => {
        if(isEditingTags) {
            $c.append($(`<div style="display:flex;gap:5px;width:100%;margin-bottom:5px;"><input class="pw-input tn" value="${t.name}" style="flex:1"><input class="pw-input tv" value="${t.value}" style="flex:1"><div class="pw-btn danger" style="width:30px;" onclick="window.delTag(${i})"><i class="fa fa-trash"></i></div></div>`).on('input', function(){ t.name=$(this).find('.tn').val(); t.value=$(this).find('.tv').val(); saveData(); }));
        } else {
            $c.append($(`<div class="pw-tag-chip"><span>${t.name}</span></div>`).on('click', () => { $('#pw-request').val($('#pw-request').val() + (t.value ? `${t.name}: ${t.value}\n` : `${t.name}: `)).focus(); }));
        }
    });
    if(isEditingTags) $c.append($(`<div class="pw-tag-add-btn" style="width:100%;text-align:center;">+ 新增</div>`).on('click', ()=>{ tagsCache.push({name:"",value:""}); saveData(); renderTagsList(); }));
    window.delTag = (i) => { tagsCache.splice(i,1); saveData(); renderTagsList(); };
};

const renderHistoryList = () => {
    loadData();
    const $c = $('#pw-history-list').empty();
    if(historyCache.length===0) $c.html('<div style="opacity:0.5;text-align:center;padding:10px;">无历史记录</div>');
    historyCache.forEach(h => {
        const preview = h.data ? Object.entries(h.data).map(([k,v]) => `${k}:${v}`).join(', ').slice(0, 50) : "无内容";
        $c.append($(`
            <div class="pw-history-item" style="flex-direction:column;gap:5px;">
                <div style="display:flex;justify-content:space-between;font-size:0.8em;opacity:0.7;"><span>${h.timestamp}</span><span>${h.name}</span></div>
                <div style="font-size:0.9em;">${preview}...</div>
            </div>
        `).on('click', () => {
            currentDataList = h.data;
            renderEditorList(currentDataList);
            $('#pw-result-area').show();
            $('.pw-tab[data-tab="editor"]').click();
        }));
    });
};

window.pwExtraBooks = [];
const renderWiBooks = async () => {
    const container = $('#pw-wi-container').empty();
    const baseBooks = await getContextWorldBooks();
    const allBooks = [...new Set([...baseBooks, ...(window.pwExtraBooks || [])])];

    if (allBooks.length === 0) container.html('<div style="opacity:0.6; padding:10px; text-align:center;">暂无世界书</div>');

    for (const book of allBooks) {
        const isBound = baseBooks.includes(book);
        const $el = $(`
            <div class="pw-wi-book">
                <div class="pw-wi-header">
                    <span><i class="fa-solid fa-book"></i> ${book} ${isBound ? '<span style="color:#9ece6a;font-size:0.8em;">(已绑定)</span>' : ''}</span>
                    ${!isBound ? '<i class="fa-solid fa-times remove-book" style="color:#ff6b6b;" title="移除"></i>' : ''}
                </div>
            </div>
        `);
        $el.find('.remove-book').on('click', (e) => { e.stopPropagation(); window.pwExtraBooks = window.pwExtraBooks.filter(b => b !== book); renderWiBooks(); });
        container.append($el);
    }
};

// ============================================================================
// 初始化
// ============================================================================

function addPersonaButton() {
    if (!$('#'+BUTTON_ID).length && $('.persona_controls_buttons_block').length) {
        $('.persona_controls_buttons_block').prepend($(`<div id="${BUTTON_ID}" class="menu_button fa-solid fa-wand-magic-sparkles interactable" title="${TEXT.BTN_TITLE}" tabindex="0"></div>`).on('click', openCreatorPopup));
    }
}

jQuery(async () => {
    injectStyles();
    addPersonaButton();
    new MutationObserver(addPersonaButton).observe(document.body, { childList: true, subtree: true });
    console.log(`${extensionName} v20 loaded.`);
});
