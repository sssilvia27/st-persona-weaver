import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, callPopup, getRequestHeaders } from "../../../../script.js";

// ============================================================================
// 1. 常量与配置
// ============================================================================

const extensionName = "st-persona-weaver";
const STORAGE_KEY_HISTORY = 'pw_history_v3';
const STORAGE_KEY_STATE = 'pw_state_v4'; 
const STORAGE_KEY_TAGS = 'pw_tags_v1';

// 默认标签库 (支持默认值)
const defaultTags = [
    { name: "姓名", value: "" },
    { name: "年龄", value: "" },
    { name: "性别", value: "" },
    { name: "MBTI", value: "" },
    { name: "职业", value: "" },
    { name: "阵营", value: "" },
    { name: "外貌", value: "" },
    { name: "性格", value: "" },
    { name: "关系", value: "" },
    { name: "XP/性癖", value: "" },
    { name: "秘密", value: "" }
];

const defaultSettings = {
    autoSwitchPersona: true,
    syncToWorldInfo: true,
    historyLimit: 10,
    outputFormat: 'yaml', // 'yaml' | 'paragraph'
    
    // API 设置
    apiSource: 'main', // 'main' | 'independent'
    indepApiUrl: 'https://api.openai.com/v1',
    indepApiKey: '',
    indepApiModel: 'gpt-3.5-turbo'
};

const TEXT = {
    PANEL_TITLE: "用户设定编织者 Pro",
    BTN_OPEN_MAIN: "✨ 打开设定生成器",
    LABEL_TAGS: "点击标签插入 (右键/长按编辑)",
    LABEL_REQ: "我的要求 / 设定填空 (支持混合输入)",
    BTN_ADD_TAG: "+",
    TOAST_API_OK: "✅ API 连接成功",
    TOAST_API_ERR: "❌ API 连接失败",
    TOAST_GEN_FAIL: "生成失败，请检查 API 设置"
};

// ============================================================================
// 2. 状态与存储
// ============================================================================

let historyCache = [];
let tagsCache = [];
let worldInfoCache = {}; 
let availableWorldBooks = []; // 所有可用的书名

function loadData() {
    try { historyCache = JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY)) || []; } catch { historyCache = []; }
    try { tagsCache = JSON.parse(localStorage.getItem(STORAGE_KEY_TAGS)) || defaultTags; } catch { tagsCache = defaultTags; }
}

function saveData() {
    localStorage.setItem(STORAGE_KEY_TAGS, JSON.stringify(tagsCache));
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(historyCache));
}

function saveState(data) {
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(data));
}

function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_STATE)) || {}; } catch { return {}; }
}

function injectStyles() {
    const styleId = 'persona-weaver-css-v4';
    if ($(`#${styleId}`).length) return;

    const css = `
    .pw-wrapper { display: flex; flex-direction: column; height: 100%; text-align: left; font-size: 0.95em; min-height: 600px; }
    
    /* Header */
    .pw-header { background: var(--SmartThemeBg); border-bottom: 1px solid var(--SmartThemeBorderColor); display: flex; flex-direction: column; flex-shrink: 0; }
    .pw-top-bar { padding: 10px 15px; display: flex; justify-content: space-between; align-items: center; }
    .pw-title { font-weight: bold; font-size: 1.1em; display: flex; align-items: center; gap: 8px; }
    .pw-tools i { cursor: pointer; margin-left: 15px; opacity: 0.7; transition: 0.2s; font-size: 1.1em; }
    .pw-tools i:hover { opacity: 1; color: var(--SmartThemeQuoteColor); }

    /* Tabs */
    .pw-tabs { display: flex; background: var(--black30a); user-select: none; }
    .pw-tab { flex: 1; text-align: center; padding: 8px; cursor: pointer; border-bottom: 3px solid transparent; opacity: 0.7; font-size: 0.9em; font-weight: bold; transition: 0.2s; }
    .pw-tab:hover { background: var(--white10a); opacity: 1; }
    .pw-tab.active { border-bottom-color: var(--SmartThemeQuoteColor); opacity: 1; color: var(--SmartThemeQuoteColor); background: var(--white05a); }

    /* Views */
    .pw-view { display: none; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
    .pw-view.active { display: flex; }
    .pw-scroll-area { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 15px; }

    /* Tags */
    .pw-tags-container { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; background: var(--black10a); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); margin-bottom: 5px; }
    .pw-tag { padding: 3px 8px; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; cursor: pointer; font-size: 0.85em; user-select: none; display: flex; align-items: center; gap: 4px; }
    .pw-tag:hover { border-color: var(--SmartThemeQuoteColor); color: var(--SmartThemeQuoteColor); }
    .pw-tag-val { opacity: 0.6; font-size: 0.9em; margin-left: 2px; }
    .pw-tag-add { border-style: dashed; opacity: 0.7; }

    /* World Info Tree */
    .pw-wi-controls { display: flex; gap: 10px; margin-bottom: 10px; }
    .pw-wi-select { flex: 1; }
    .pw-wi-book { border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; overflow: hidden; margin-bottom: 8px; background: var(--black10a); }
    .pw-wi-header { padding: 8px 12px; background: var(--black30a); cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-weight: bold; font-size: 0.9em; }
    .pw-wi-header:hover { background: var(--white10a); }
    .pw-wi-header .actions { font-size: 0.8em; opacity: 0.6; font-weight: normal; margin-right: 10px; }
    .pw-wi-list { display: none; padding: 0; border-top: 1px solid var(--SmartThemeBorderColor); max-height: 400px; overflow-y: auto; }
    .pw-wi-item { padding: 8px 12px; border-bottom: 1px solid var(--white05a); font-size: 0.85em; display: flex; flex-direction: column; gap: 4px; }
    .pw-wi-item-top { display: flex; align-items: center; gap: 8px; }
    .pw-wi-item:last-child { border-bottom: none; }
    .pw-wi-item:hover { background: var(--white05a); }
    .pw-wi-content { font-size: 0.9em; opacity: 0.7; padding-left: 24px; white-space: pre-wrap; word-break: break-all; display: none; margin-top: 4px; border-left: 2px solid var(--white10a); }
    .pw-wi-content.show { display: block; }
    .pw-expand-btn { cursor: pointer; opacity: 0.5; padding: 2px 5px; }
    .pw-expand-btn:hover { opacity: 1; }

    /* API Settings */
    .pw-api-card { padding: 15px; background: var(--black10a); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); display: flex; flex-direction: column; gap: 12px; }
    .pw-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .pw-row label { font-weight: bold; font-size: 0.9em; }
    
    /* Common */
    .pw-textarea { width: 100%; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); color: var(--SmartThemeBodyColor); border-radius: 6px; padding: 10px; resize: vertical; min-height: 100px; font-family: inherit; line-height: 1.5; }
    .pw-textarea:focus { outline: 1px solid var(--SmartThemeQuoteColor); }
    .pw-input { width: 100%; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); color: var(--SmartThemeBodyColor); padding: 6px 10px; border-radius: 4px; }
    .pw-btn { border: none; padding: 8px; border-radius: 4px; font-weight: bold; cursor: pointer; color: white; display: inline-flex; align-items: center; justify-content: center; gap: 6px; transition: 0.2s; white-space: nowrap; }
    .pw-btn:hover { filter: brightness(1.1); transform: translateY(-1px); }
    .pw-btn.gen { background: linear-gradient(90deg, var(--SmartThemeQuoteColor), var(--SmartThemeEmColor)); width: 100%; padding: 12px; font-size: 1em; }
    .pw-btn.save { background: var(--SmartThemeEmColor); width: 100%; padding: 10px; }
    .pw-btn.normal { background: var(--SmartThemeBorderColor); color: var(--SmartThemeBodyColor); }
    
    .pw-label { font-size: 0.85em; opacity: 0.8; font-weight: bold; margin-bottom: 4px; display: flex; justify-content: space-between; }
    .pw-history-item { padding: 10px; border-bottom: 1px solid var(--white10a); cursor: pointer; }
    .pw-history-item:hover { background: var(--white05a); }
    `;
    $('<style>').attr('id', styleId).html(css).appendTo('head');
}

// ============================================================================
// 3. API 引擎 (核心升级)
// ============================================================================

async function fetchOpenAIModels(url, key) {
    try {
        const response = await fetch(`${url.replace(/\/$/, '')}/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${key}` }
        });
        if (!response.ok) throw new Error("Fetch failed");
        const data = await response.json();
        return data.data.map(m => m.id).sort();
    } catch (e) {
        console.error(e);
        return [];
    }
}

async function testApiConnection(settings) {
    try {
        const response = await fetch(`${settings.indepApiUrl.replace(/\/$/, '')}/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${settings.indepApiKey}` }
        });
        return response.ok;
    } catch { return false; }
}

async function generateWithIndependentApi(messages, settings) {
    const url = `${settings.indepApiUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
        model: settings.indepApiModel,
        messages: messages,
        temperature: 0.7,
        max_tokens: 2000
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.indepApiKey}`
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`API Error: ${response.status} - ${err}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

// ============================================================================
// 4. 业务逻辑
// ============================================================================

// 获取所有可用的世界书列表
async function loadAvailableWorldBooks() {
    try {
        // 尝试从 API 获取所有世界书文件名
        const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}) });
        if (response.ok) {
            const list = await response.json();
            availableWorldBooks = list.map(item => item.name || item).sort();
        }
    } catch (e) { console.error(e); }
}

// 获取当前上下文（绑定的+临时添加的）
async function getContextWorldBooks(extras = []) {
    const context = getContext();
    const books = new Set(extras); // 先加入临时添加的

    // 聊天绑定
    if (context.chatMetadata?.world_info) books.add(context.chatMetadata.world_info);
    
    // 角色绑定
    const charId = context.characterId;
    if (charId !== undefined && context.characters[charId]) {
        const char = context.characters[charId];
        const data = char.data || char;
        const main = data.extensions?.world || data.world || data.character_book?.name;
        if (main) books.add(main);
    }
    
    // 全局
    if (context.worldInfoSettings?.globalSelect) {
        context.worldInfoSettings.globalSelect.forEach(b => books.add(b));
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
                keys: Array.isArray(e.key) ? e.key.join(', ') : e.key,
                content: e.content,
                comment: e.comment || "",
                enabled: e.enabled
            }));
            worldInfoCache[bookName] = entries;
            return entries;
        }
    } catch {}
    return [];
}

async function runGeneration(data, apiConfig) {
    const context = getContext();
    const char = context.characters[context.characterId];
    
    let formatInst = "";
    if (data.format === 'yaml') {
        formatInst = `Output as YAML format (key: value). Keys should include Name, Age, Appearance, Personality, Background, etc.`;
    } else {
        formatInst = `Output as a descriptive narrative paragraph (Novel style, 3rd person).`;
    }

    let wiText = "";
    if (data.wiContext && data.wiContext.length > 0) {
        wiText = `\n[Reference World Info]:\n${data.wiContext.join('\n\n')}\n`;
    }

    const systemPrompt = `You are a creative writing assistant specializing in character design.
Task: Create a User Persona based on the User Request, fitting into the Current Character's scenario.
${wiText}
Current Character: ${char.name}
Scenario: ${char.scenario || "None"}

[User Request]:
${data.request}

[Response Format]:
Return ONLY a JSON object:
{
    "name": "Name",
    "description": "${formatInst}",
    "wi_entry": "A concise summary of facts about this persona for the World Info book."
}`;

    // 选择 API 路径
    if (apiConfig.apiSource === 'independent') {
        const response = await generateWithIndependentApi([{ role: 'system', content: systemPrompt }], apiConfig);
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Invalid JSON from API");
        return JSON.parse(jsonMatch[0]);
    } else {
        // 主 API
        const generatedText = await context.generateQuietPrompt(systemPrompt, false, false, "System");
        const jsonMatch = generatedText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Invalid JSON from Main API");
        return JSON.parse(jsonMatch[0]);
    }
}

// ============================================================================
// 5. UI 渲染与交互
// ============================================================================

async function openCreatorPopup() {
    const context = getContext();
    if (context.characterId === undefined) return toastr.warning(TEXT.TOAST_NO_CHAR);

    loadData();
    await loadAvailableWorldBooks();
    const savedState = loadState();
    
    // 合并配置
    const config = { ...defaultSettings, ...extension_settings[extensionName], ...savedState.localConfig };
    
    // 渲染标签HTML
    const renderTags = () => tagsCache.map((t, i) => `
        <div class="pw-tag" data-idx="${i}" title="右键编辑，左键插入">
            ${t.name}
            ${t.value ? `<span class="pw-tag-val">:${t.value}</span>` : ''}
        </div>
    `).join('') + `<div class="pw-tag pw-tag-add" title="添加标签"><i class="fa-solid fa-plus"></i></div>`;

    const html = `
    <div class="pw-wrapper">
        <div class="pw-header">
            <div class="pw-top-bar">
                <div class="pw-title"><i class="fa-solid fa-wand-magic-sparkles"></i> 设定编织者 Pro</div>
                <div class="pw-tools">
                    <i class="fa-solid fa-save" id="pw-force-save" title="保存状态"></i>
                    <i class="fa-solid fa-eraser" id="pw-clear" title="清空"></i>
                </div>
            </div>
            <div class="pw-tabs">
                <div class="pw-tab active" data-tab="editor">📝 编辑</div>
                <div class="pw-tab" data-tab="context">📚 世界书 (${config.extraBooks?.length || 0})</div>
                <div class="pw-tab" data-tab="api">⚙️ API</div>
                <div class="pw-tab" data-tab="history">📜 历史</div>
            </div>
        </div>

        <!-- 1. 编辑视图 -->
        <div id="pw-view-editor" class="pw-view active">
            <div class="pw-scroll-area">
                
                <!-- 标签栏 -->
                <div>
                    <div class="pw-label">${TEXT.LABEL_TAGS}</div>
                    <div class="pw-tags-container" id="pw-tags-list">
                        ${renderTags()}
                    </div>
                </div>

                <!-- 输入框 -->
                <div>
                    <div class="pw-label">${TEXT.LABEL_REQ}</div>
                    <textarea id="pw-request" class="pw-textarea" placeholder="例：我是他的死对头，性格冷漠... (或者点击上方标签)">${savedState.request || ''}</textarea>
                </div>

                <!-- 选项 -->
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span style="font-size:0.9em; font-weight:bold;">输出格式:</span>
                        <select id="pw-fmt-select" class="pw-input" style="padding:4px;">
                            <option value="yaml" ${config.outputFormat === 'yaml' ? 'selected' : ''}>YAML 属性表 (推荐)</option>
                            <option value="paragraph" ${config.outputFormat === 'paragraph' ? 'selected' : ''}>小说段落</option>
                        </select>
                    </div>
                </div>

                <button id="pw-btn-gen" class="pw-btn gen"><i class="fa-solid fa-bolt"></i> 生成 / 润色 (Iterate)</button>

                <!-- 结果区域 -->
                <div id="pw-result-area" style="display: ${savedState.hasResult ? 'block' : 'none'}; border-top: 1px dashed var(--SmartThemeBorderColor); padding-top: 10px;">
                    <div class="pw-label" style="color:var(--SmartThemeQuoteColor); display:flex; justify-content:space-between;">
                        <span><i class="fa-solid fa-check-circle"></i> 生成结果 (可编辑)</span>
                    </div>
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        <input type="text" id="pw-res-name" class="pw-input" placeholder="角色名称" value="${savedState.name || ''}">
                        <textarea id="pw-res-desc" class="pw-textarea" rows="6" placeholder="用户设定描述">${savedState.desc || ''}</textarea>
                        
                        <div style="background:var(--black10a); padding:8px; border-radius:6px; border:1px solid var(--SmartThemeBorderColor);">
                            <div style="display:flex; align-items:center; gap:5px; margin-bottom:5px;">
                                <input type="checkbox" id="pw-wi-toggle" checked>
                                <span style="font-size:0.9em; font-weight:bold;">同步写入世界书</span>
                            </div>
                            <textarea id="pw-res-wi" class="pw-textarea" rows="3" placeholder="世界书条目内容...">${savedState.wiContent || ''}</textarea>
                        </div>
                    </div>
                    <button id="pw-btn-apply" class="pw-btn save" style="margin-top:10px;"><i class="fa-solid fa-check"></i> 保存并启用</button>
                </div>
            </div>
        </div>

        <!-- 2. 世界书上下文视图 -->
        <div id="pw-view-context" class="pw-view">
            <div class="pw-scroll-area">
                <div class="pw-label">挂载额外的世界书 (仅对本次生成有效)</div>
                <div class="pw-wi-controls">
                    <select id="pw-wi-select" class="pw-input pw-wi-select">
                        <option value="">-- 选择要添加的世界书 --</option>
                        ${availableWorldBooks.map(b => `<option value="${b}">${b}</option>`).join('')}
                    </select>
                    <button id="pw-wi-add" class="pw-btn normal"><i class="fa-solid fa-plus"></i> 添加</button>
                </div>
                <div id="pw-wi-container"></div>
            </div>
        </div>

        <!-- 3. API 设置视图 -->
        <div id="pw-view-api" class="pw-view">
            <div class="pw-scroll-area">
                <div class="pw-api-card">
                    <div class="pw-row">
                        <label>API 来源</label>
                        <select id="pw-api-source" class="pw-input" style="width:150px;">
                            <option value="main" ${config.apiSource === 'main' ? 'selected' : ''}>主 API (默认)</option>
                            <option value="independent" ${config.apiSource === 'independent' ? 'selected' : ''}>独立 API</option>
                        </select>
                    </div>
                    
                    <div id="pw-indep-settings" style="display:${config.apiSource === 'independent' ? 'flex' : 'none'}; flex-direction:column; gap:10px;">
                        <hr style="border:0; border-top:1px solid var(--white10a); width:100%;">
                        <div class="pw-row">
                            <label>API URL</label>
                            <input type="text" id="pw-api-url" class="pw-input" value="${config.indepApiUrl}" placeholder="https://api.openai.com/v1">
                        </div>
                        <div class="pw-row">
                            <label>API Key</label>
                            <input type="password" id="pw-api-key" class="pw-input" value="${config.indepApiKey}" placeholder="sk-...">
                        </div>
                        <div class="pw-row">
                            <label>Model</label>
                            <div style="display:flex; gap:5px; flex:1; justify-content:flex-end;">
                                <input type="text" id="pw-api-model" class="pw-input" value="${config.indepApiModel}" style="width:100%;">
                                <button id="pw-api-refresh" class="pw-btn normal" title="刷新模型列表"><i class="fa-solid fa-sync"></i></button>
                            </div>
                        </div>
                        <div style="text-align:right;">
                            <button id="pw-api-test" class="pw-btn normal" style="width:auto; display:inline-flex;">测试连接</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 4. 历史视图 -->
        <div id="pw-view-history" class="pw-view">
            <div class="pw-scroll-area" id="pw-history-list"></div>
        </div>
    </div>
    `;

    // 渲染主弹窗
    callPopup(html, 'text', '', { wide: true, large: true, okButton: "关闭" });

    // --- 逻辑绑定 ---
    
    // 1. 状态自动保存
    const saveCurrentState = () => {
        const state = {
            request: $('#pw-request').val(),
            name: $('#pw-res-name').val(),
            desc: $('#pw-res-desc').val(),
            wiContent: $('#pw-res-wi').val(),
            hasResult: $('#pw-result-area').is(':visible'),
            localConfig: {
                outputFormat: $('#pw-fmt-select').val(),
                apiSource: $('#pw-api-source').val(),
                indepApiUrl: $('#pw-api-url').val(),
                indepApiKey: $('#pw-api-key').val(),
                indepApiModel: $('#pw-api-model').val(),
                extraBooks: window.pwExtraBooks || [] // 暂存当前的额外书列表
            }
        };
        saveState(state);
    };
    $(document).on('input change.pw', '#pw-request, #pw-res-name, #pw-res-desc, #pw-res-wi, .pw-input', saveCurrentState);
    $('#pw-force-save').on('click', () => { saveCurrentState(); toastr.success("状态已保存"); });

    // 2. Tab 切换
    $(document).on('click.pw', '.pw-tab', function() {
        $('.pw-tab').removeClass('active');
        $(this).addClass('active');
        $('.pw-view').removeClass('active');
        $(`#pw-view-${$(this).data('tab')}`).addClass('active');
    });

    // 3. 标签系统 (新增编辑功能)
    const refreshTagUI = () => $('#pw-tags-list').html(renderTags());
    
    $(document).on('click.pw', '.pw-tag', function(e) {
        if ($(this).hasClass('pw-tag-add')) {
            // 添加新标签
            callPopup(`
                <div style="display:flex; flex-direction:column; gap:10px;">
                    <input id="new-tag-name" class="pw-input" placeholder="标签名 (如: 种族)">
                    <input id="new-tag-val" class="pw-input" placeholder="预填值 (可选, 如: 精灵)">
                </div>
            `, 'confirm').then(yes => {
                if (yes) {
                    const name = $('#new-tag-name').val();
                    const val = $('#new-tag-val').val();
                    if (name) {
                        tagsCache.push({ name, value: val });
                        saveData();
                        refreshTagUI();
                    }
                }
            });
            return;
        }
        
        // 插入标签内容
        const idx = $(this).data('idx');
        const tag = tagsCache[idx];
        const $text = $('#pw-request');
        const cur = $text.val();
        const insert = tag.value ? `${tag.name}: ${tag.value}` : `${tag.name}: `;
        $text.val(cur ? cur + '\n' + insert : insert).focus();
        $text[0].scrollTop = $text[0].scrollHeight;
        saveCurrentState();
    });

    // 右键编辑标签
    $(document).on('contextmenu.pw', '.pw-tag', function(e) {
        if ($(this).hasClass('pw-tag-add')) return;
        e.preventDefault();
        const idx = $(this).data('idx');
        const tag = tagsCache[idx];
        
        callPopup(`
            <div style="display:flex; flex-direction:column; gap:10px;">
                <label>编辑标签</label>
                <input id="edit-tag-name" class="pw-input" value="${tag.name}">
                <input id="edit-tag-val" class="pw-input" value="${tag.value}" placeholder="预填默认值">
                <button id="del-tag-btn" class="pw-btn" style="background:var(--SmartThemeColorRed);">删除此标签</button>
            </div>
        `, 'confirm').then(yes => {
            if (yes) {
                tagsCache[idx].name = $('#edit-tag-name').val();
                tagsCache[idx].value = $('#edit-tag-val').val();
                saveData();
                refreshTagUI();
            }
        });
        
        // 绑定删除按钮 (在Confirm关闭前点击有效吗？ST的popup比较特殊，简单起见我们把删除逻辑做在确认后，或者用额外的flag)
        // 更好的方式是再弹一个确认
        setTimeout(() => {
            $('#del-tag-btn').on('click', () => {
                if(confirm("确定删除?")) {
                    tagsCache.splice(idx, 1);
                    saveData();
                    refreshTagUI();
                    $('.popup_close').click(); // 关闭编辑窗
                }
            });
        }, 100);
    });

    // 4. 世界书逻辑
    window.pwExtraBooks = savedState.localConfig?.extraBooks || [];
    
    const renderWiBooks = async () => {
        const container = $('#pw-wi-container').empty();
        // 获取所有书 (基础+额外)
        const baseBooks = await getContextWorldBooks();
        const allBooks = [...new Set([...baseBooks, ...window.pwExtraBooks])];

        for (const book of allBooks) {
            const $el = $(`
                <div class="pw-wi-book">
                    <div class="pw-wi-header">
                        <span>📖 ${book}</span>
                        <div>
                            ${baseBooks.includes(book) ? '<span class="actions">[绑定]</span>' : '<span class="actions remove-book" style="color:red;cursor:pointer;">[移除]</span>'}
                            <i class="fa-solid fa-chevron-down"></i>
                        </div>
                    </div>
                    <div class="pw-wi-list" data-book="${book}"></div>
                </div>
            `);
            
            // 点击移除
            $el.find('.remove-book').on('click', (e) => {
                e.stopPropagation();
                window.pwExtraBooks = window.pwExtraBooks.filter(b => b !== book);
                renderWiBooks();
            });

            // 点击展开加载
            $el.find('.pw-wi-header').on('click', async function() {
                const $list = $el.find('.pw-wi-list');
                if ($list.is(':visible')) {
                    $list.slideUp();
                } else {
                    $list.slideDown();
                    if (!$list.data('loaded')) {
                        $list.html('<div style="padding:10px;text-align:center;"><i class="fas fa-spinner fa-spin"></i></div>');
                        const entries = await getWorldBookEntries(book);
                        $list.empty();
                        
                        if (entries.length === 0) $list.html('<div style="padding:10px;opacity:0.5;">无内容</div>');
                        
                        entries.forEach(entry => {
                            const isChecked = entry.enabled ? 'checked' : '';
                            const $item = $(`
                                <div class="pw-wi-item">
                                    <div class="pw-wi-item-top">
                                        <input type="checkbox" class="pw-wi-check" ${isChecked} data-content="${encodeURIComponent(entry.content)}">
                                        <span style="font-weight:bold;">${entry.keys.split(',')[0]}</span>
                                        <i class="fa-solid fa-eye pw-expand-btn" title="预览内容"></i>
                                    </div>
                                    <div class="pw-wi-content">${entry.content}</div>
                                </div>
                            `);
                            $item.find('.pw-expand-btn').on('click', function() {
                                $(this).closest('.pw-wi-item').find('.pw-wi-content').toggleClass('show');
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
    renderWiBooks();

    $('#pw-wi-add').on('click', () => {
        const val = $('#pw-wi-select').val();
        if (val && !window.pwExtraBooks.includes(val)) {
            window.pwExtraBooks.push(val);
            renderWiBooks();
        }
    });

    // 5. API 设置逻辑
    $('#pw-api-source').on('change', function() {
        if ($(this).val() === 'independent') $('#pw-indep-settings').css('display', 'flex');
        else $('#pw-indep-settings').hide();
        saveCurrentState();
    });

    $('#pw-api-test').on('click', async function() {
        const ok = await testApiConnection({
            indepApiUrl: $('#pw-api-url').val(),
            indepApiKey: $('#pw-api-key').val()
        });
        toastr[ok ? 'success' : 'error'](ok ? TEXT.TOAST_API_OK : TEXT.TOAST_API_ERR);
    });

    $('#pw-api-refresh').on('click', async function() {
        const models = await fetchOpenAIModels($('#pw-api-url').val(), $('#pw-api-key').val());
        if (models.length) {
            toastr.success(`获取到 ${models.length} 个模型`);
            // 简单处理：提示用户。或者我们可以做一个 datalist，但 SillyTavern 的 input 本身支持比较好。
            // 这里我们直接弹窗让用户复制，或者填入第一个
            $('#pw-api-model').val(models[0]); // 自动填第一个
        } else {
            toastr.error("获取模型列表失败");
        }
    });

    // 6. 生成与保存 (支持迭代)
    $('#pw-btn-gen').on('click', async function() {
        const req = $('#pw-request').val();
        const curName = $('#pw-res-name').val();
        const curDesc = $('#pw-res-desc').val();
        
        // 构建完整 prompt (包含已有内容以支持微调)
        let fullReq = req;
        if (curName || curDesc) {
            fullReq += `\n\n[Current Draft (For Refinement)]:\nName: ${curName}\nDescription: ${curDesc}`;
        }

        const $btn = $(this);
        const oldText = $btn.html();
        $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 处理中...');

        // 收集世界书上下文
        const wiContext = [];
        $('.pw-wi-check:checked').each(function() {
            wiContext.push(decodeURIComponent($(this).data('content')));
        });

        const config = {
            request: fullReq,
            format: $('#pw-fmt-select').val(),
            wiContext: wiContext,
            apiSource: $('#pw-api-source').val(),
            indepApiUrl: $('#pw-api-url').val(),
            indepApiKey: $('#pw-api-key').val(),
            indepApiModel: $('#pw-api-model').val()
        };

        try {
            const data = await runGeneration(config, config);
            
            $('#pw-res-name').val(data.name);
            $('#pw-res-desc').val(data.description);
            $('#pw-res-wi').val(data.wi_entry || data.description);
            $('#pw-result-area').fadeIn();
            
            saveHistory({ request: req, data });
            saveCurrentState();
        } catch (e) {
            console.error(e);
            toastr.error(`${TEXT.TOAST_GEN_FAIL}: ${e.message}`);
        } finally {
            $btn.prop('disabled', false).html(oldText);
        }
    });

    // 7. 历史记录
    $(document).on('click.pw', '.pw-tab[data-tab="history"]', function() {
        loadData();
        const $list = $('#pw-history-list').empty();
        historyCache.forEach(item => {
            const $el = $(`
                <div class="pw-history-item">
                    <div style="font-weight:bold;">${item.data.name}</div>
                    <div style="font-size:0.8em;opacity:0.7;">${item.timestamp}</div>
                    <div style="font-size:0.8em;opacity:0.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item.request}</div>
                </div>
            `);
            $el.on('click', () => {
                $('#pw-request').val(item.request);
                $('#pw-res-name').val(item.data.name);
                $('#pw-res-desc').val(item.data.description);
                $('#pw-res-wi').val(item.data.wi_entry);
                $('#pw-result-area').show();
                $('.pw-tab[data-tab="editor"]').click();
            });
            $list.append($el);
        });
    });

    // 保存逻辑保持不变 (Save & Apply)
    // ... (Use existing logic from previous version, just re-bind)
    $('#pw-btn-apply').on('click', async function() {
        const name = $('#pw-res-name').val();
        const desc = $('#pw-res-desc').val();
        const wiContent = $('#pw-res-wi').val();
        
        if (!name) return toastr.warning("Name required");
        
        const context = getContext();
        if (!context.powerUserSettings.personas) context.powerUserSettings.personas = {};
        context.powerUserSettings.personas[name] = desc;
        await saveSettingsDebounced();

        if ($('#pw-wi-toggle').is(':checked') && wiContent) {
            // 写入到第一本绑定的书
            const books = await getContextWorldBooks();
            if (books.length > 0) {
                const book = books[0];
                try {
                    const headers = getRequestHeaders();
                    const r = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name: book }) });
                    if (r.ok) {
                        const d = await r.json();
                        if (!d.entries) d.entries = {};
                        const ids = Object.keys(d.entries).map(Number);
                        const newId = ids.length ? Math.max(...ids) + 1 : 0;
                        d.entries[newId] = { uid: newId, key: [name, "User"], content: wiContent, comment: `User: ${name}`, enabled: true, selective: true };
                        await fetch('/api/worldinfo/edit', { method: 'POST', headers, body: JSON.stringify({ name: book, data: d }) });
                        toastr.success(`WI Updated: ${book}`);
                        if (context.updateWorldInfoList) context.updateWorldInfoList();
                    }
                } catch(e) { console.error(e); }
            }
        }

        if (defaultSettings.autoSwitchPersona) {
            context.powerUserSettings.persona_selected = name;
            $("#your_name").val(name).trigger("input").trigger("change");
            $("#your_desc").val(desc).trigger("input").trigger("change");
        }
        toastr.success(TEXT.TOAST_SAVE_SUCCESS(name));
        $('.popup_close').click();
    });

    // 清空
    $('#pw-clear').on('click', () => {
        if (confirm("Clear all?")) {
            $('#pw-request, #pw-res-name, #pw-res-desc, #pw-res-wi').val('');
            $('#pw-result-area').hide();
            saveCurrentState();
        }
    });
}

// ============================================================================
// 初始化
// ============================================================================

jQuery(async () => {
    injectStyles();
    
    // Extensions Menu Button
    $("#extensions_settings2").append(`
        <div class="world-info-cleanup-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header"><b>${TEXT.PANEL_TITLE}</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
                <div class="inline-drawer-content">
                    <div style="margin:10px 0;"><input id="pw_open_btn" class="menu_button" type="button" value="${TEXT.BTN_OPEN_MAIN}" style="width:100%;font-weight:bold;background:var(--SmartThemeQuoteColor);color:#fff;" /></div>
                </div>
            </div>
        </div>
    `);
    $("#pw_open_btn").on("click", openCreatorPopup);
    console.log(`${extensionName} v4 loaded.`);
});
