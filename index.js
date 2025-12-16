import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, callPopup, getRequestHeaders } from "../../../../script.js";

// ============================================================================
// 1. 常量与配置
// ============================================================================

const extensionName = "st-persona-weaver";
const STORAGE_KEY_HISTORY = 'pw_history_v10';
const STORAGE_KEY_STATE = 'pw_state_v10';
const STORAGE_KEY_TAGS = 'pw_tags_v4';

const defaultTags = [
    { name: "姓名", value: "" },
    { name: "性别", value: "" },
    { name: "年龄", value: "" },
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
    historyLimit: 50,
    outputFormat: 'yaml',
    apiSource: 'main',
    indepApiUrl: 'https://api.openai.com/v1',
    indepApiKey: '',
    indepApiModel: 'gpt-3.5-turbo'
};

const TEXT = {
    PANEL_TITLE: "用户设定编织者 Pro",
    BTN_OPEN_MAIN: "打开设定生成器",
    LABEL_TAGS: "点击插入标签",
    TOAST_NO_CHAR: "请先打开一个角色聊天",
    TOAST_API_OK: "API 连接成功",
    TOAST_API_ERR: "API 连接失败",
    TOAST_SAVE_API: "API 设置已保存",
    TOAST_SNAPSHOT: "已存入历史记录",
    TOAST_GEN_FAIL: "生成失败，请检查 API 设置",
    TOAST_SAVE_SUCCESS: (name) => `设定已保存并切换为: ${name}`
};

// ============================================================================
// 2. 状态与存储
// ============================================================================

let historyCache = [];
let tagsCache = [];
let worldInfoCache = {};
let availableWorldBooks = [];
let isTagEditMode = false;

function loadData() {
    try { historyCache = JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY)) || []; } catch { historyCache = []; }
    try { tagsCache = JSON.parse(localStorage.getItem(STORAGE_KEY_TAGS)) || defaultTags; } catch { tagsCache = defaultTags; }
}

function saveData() {
    localStorage.setItem(STORAGE_KEY_TAGS, JSON.stringify(tagsCache));
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(historyCache));
}

function saveHistory(item) {
    const context = getContext();
    const charName = context.characters[context.characterId]?.name || "未知角色";
    item.timestamp = new Date().toLocaleString();
    item.targetChar = charName;

    if (!item.data.name) {
        item.data.name = item.request.length > 15 ? item.request.substring(0, 15) + "..." : item.request;
    }
    if (!item.data.name) item.data.name = "未命名设定";

    historyCache.unshift(item);
    const limit = extension_settings[extensionName]?.historyLimit || 50;
    if (historyCache.length > limit) historyCache = historyCache.slice(0, limit);
    saveData();
}

function updateHistoryTitle(index, newTitle) {
    if (historyCache[index]) {
        historyCache[index].data.customTitle = newTitle;
        saveData();
    }
}

function saveState(data) {
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(data));
}

function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_STATE)) || {}; } catch { return {}; }
}

// [优化] 加载外部 CSS 文件
function loadCSS() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = 'scripts/extensions/third-party/st-persona-weaver/style.css';
    link.id = 'persona-weaver-css-v10';
    if (!document.getElementById(link.id)) {
        document.head.appendChild(link);
    }
}

// ============================================================================
// 3. 业务逻辑 (API 测试, 世界书, 生成)
// ============================================================================

// [新增] 健壮的 JSON 提取函数，处理 Markdown 代码块
function extractJson(str) {
    if (typeof str !== 'string') return null;
    try {
        // 尝试直接解析
        return JSON.parse(str);
    } catch (e) {
        // 尝试提取 Markdown 代码块
        const codeBlockMatch = str.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (codeBlockMatch) {
            try { return JSON.parse(codeBlockMatch[1]); } catch {}
        }
        // 尝试提取第一个 {} 包裹的内容
        const bracketMatch = str.match(/(\{[\s\S]*\})/);
        if (bracketMatch) {
            try { return JSON.parse(bracketMatch[1]); } catch {}
        }
    }
    throw new Error("无法从回复中解析 JSON 数据");
}

async function testApiConnection() {
    const apiSource = $('#pw-api-source').val();
    const url = $('#pw-api-url').val();
    const key = $('#pw-api-key').val();
    const model = $('#pw-api-model').val();

    try {
        toastr.info("正在测试 API 连接...", "请稍候");
        
        if (apiSource === 'independent') {
            const res = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                body: JSON.stringify({
                    model: model,
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 5
                })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await res.json();
        } else {
            const context = getContext();
            if (!context.generateQuietPrompt) throw new Error("主 API 不可用");
        }
        toastr.success("API 连接正常！", "测试成功");
    } catch (e) {
        toastr.error(`连接失败: ${e.message}`, "API 测试");
    }
}

async function loadAvailableWorldBooks() {
    availableWorldBooks = [];
    const context = getContext();
    
    // 优先使用 TavernHelper 获取
    if (window.TavernHelper && typeof window.TavernHelper.getWorldbookNames === 'function') {
        try { availableWorldBooks = window.TavernHelper.getWorldbookNames(); } catch (e) { console.warn("[PW] TavernHelper load failed", e); }
    }

    // 后备方案：API 获取
    if (!availableWorldBooks || availableWorldBooks.length === 0) {
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
    }

    // 后备方案：Context
    if (availableWorldBooks.length === 0) {
         if (context.world_names && Array.isArray(context.world_names)) {
            availableWorldBooks = [...context.world_names];
        } else if (window.world_names && Array.isArray(window.world_names)) {
            availableWorldBooks = [...window.world_names];
        }
    }
    
    availableWorldBooks = [...new Set(availableWorldBooks)].filter(x => x).sort();
}

async function getContextWorldBooks(extras = []) {
    const context = getContext();
    const books = new Set(extras); 

    const charId = context.characterId;
    if (charId !== undefined && context.characters[charId]) {
        const char = context.characters[charId];
        const data = char.data || char;
        const main = data.extensions?.world || data.world || data.character_book?.name;
        if (main) books.add(main);
    }
    
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
                displayName: e.comment && e.comment.trim() !== "" ? e.comment : (Array.isArray(e.key) ? e.key.join(', ') : e.key),
                keys: Array.isArray(e.key) ? e.key.join(', ') : e.key,
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
    } catch (e) {
        console.error(e);
        return [];
    }
}

async function runGeneration(data, apiConfig) {
    const context = getContext();
    const char = context.characters[context.characterId];
    
    const formatInst = data.format === 'yaml' 
        ? `"description": "Use YAML format key-value pairs inside this string. Keys: Name, Age, Role, Appearance, Personality, Background, etc."`
        : `"description": "Narrative paragraph style (Novel style, 3rd person). Approx 200 words."`;

    let wiText = "";
    if (data.wiContext && data.wiContext.length > 0) {
        wiText = `\n[Context/World Info]:\n${data.wiContext.join('\n\n')}\n`;
    }

    const systemPrompt = `You are a creative writing assistant.
Task: Create a detailed User Persona based on the Request.
${wiText}
Target Character: ${char.name}
Scenario: ${char.scenario || "None"}

[User Request]:
${data.request}

[Response Format]:
Return ONLY a JSON object:
{
    "name": "Name",
    "description": ${formatInst},
    "wi_entry": "Concise facts for World Info."
}`;

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
        const content = json.choices[0].message.content;
        return extractJson(content);
    } else {
        // [修复] 参数对齐：prompt, quiet_to_loud, skip_wian, quiet_image, quiet_name
        // 注意：generateQuietPrompt 的参数顺序在不同 ST 版本可能有变，通常传递 (prompt, false, false, null, "System") 是安全的
        const generatedText = await context.generateQuietPrompt(systemPrompt, false, false, null, "PersonaWeaver");
        return extractJson(generatedText);
    }
}

// ============================================================================
// 4. UI 渲染与交互
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
    isTagEditMode = false;

    // 渲染标签列表
    const renderTags = () => {
        let html = tagsCache.map((t, i) => `
            <div class="pw-tag ${isTagEditMode ? 'edit-mode' : ''}" data-idx="${i}">
                ${isTagEditMode ? '<i class="fa-solid fa-pen"></i>' : '<i class="fa-solid fa-tag" style="opacity:0.5;font-size:0.8em;"></i>'}
                ${t.name}
                ${!isTagEditMode && t.value ? `<span class="pw-tag-val">:${t.value}</span>` : ''}
            </div>
        `).join('');
        html += `<div class="pw-tag pw-tag-add" title="添加新标签"><i class="fa-solid fa-plus"></i></div>`;
        return html;
    };

    const wiOptions = availableWorldBooks.length > 0 
        ? availableWorldBooks.map(b => `<option value="${b}">${b}</option>`).join('')
        : `<option disabled>未找到世界书</option>`;

    // HTML 结构保持原样，省略大段重复代码，只展示核心挂载点
    // 实际使用时请将原有的 HTML 模板复制回这里
    const html = `
    <div class="pw-wrapper">
        <div class="pw-header">
            <div class="pw-top-bar">
                <div class="pw-title"><i class="fa-solid fa-wand-magic-sparkles"></i> 设定编织者 Pro</div>
            </div>
            <div class="pw-tabs">
                <div class="pw-tab active" data-tab="editor">📝 编辑</div>
                <div class="pw-tab" data-tab="context">📚 世界书</div>
                <div class="pw-tab" data-tab="api">⚙️ API</div>
                <div class="pw-tab" data-tab="history">📜 历史</div>
            </div>
        </div>

        <!-- 1. 编辑视图 -->
        <div id="pw-view-editor" class="pw-view active">
            <div class="pw-scroll-area">
                <div>
                    <div class="pw-label" style="display:flex; justify-content:space-between; align-items:center;">
                        <span>${TEXT.LABEL_TAGS}</span>
                        <i class="fa-solid fa-gear pw-tags-edit-btn" title="编辑/删除标签"></i>
                    </div>
                    <div class="pw-tags-wrapper">
                        <div class="pw-tags-container" id="pw-tags-list">
                            ${renderTags()}
                        </div>
                    </div>
                </div>

                <div style="flex:1; display:flex; flex-direction:column;">
                    <textarea id="pw-request" class="pw-textarea" placeholder="在此输入要求，或点击上方标签..." style="flex:1;">${savedState.request || ''}</textarea>
                    
                    <div class="pw-editor-controls" style="margin-top:5px;">
                        <div style="display:flex; gap:10px;">
                            <div class="pw-mini-btn" id="pw-clear"><i class="fa-solid fa-eraser"></i> 清空</div>
                            <div class="pw-mini-btn" id="pw-snapshot"><i class="fa-solid fa-save"></i> 存入历史</div>
                        </div>
                        <div style="display:flex; align-items:center; gap:5px; margin-top:5px;">
                            <span style="font-size:0.85em; opacity:0.7;">格式:</span>
                            <select id="pw-fmt-select" class="pw-input" style="padding:2px 6px;">
                                <option value="yaml" ${config.outputFormat === 'yaml' ? 'selected' : ''}>YAML 属性表</option>
                                <option value="paragraph" ${config.outputFormat === 'paragraph' ? 'selected' : ''}>小说段落</option>
                            </select>
                        </div>
                    </div>
                </div>

                <button id="pw-btn-gen" class="pw-btn gen"><i class="fa-solid fa-bolt"></i> 生成 / 润色</button>

                <div id="pw-result-area" style="display: ${savedState.hasResult ? 'block' : 'none'}; border-top: 1px dashed var(--SmartThemeBorderColor); padding-top: 10px; margin-top:10px;">
                    <div class="pw-label" style="color:var(--SmartThemeQuoteColor);">
                        <i class="fa-solid fa-check-circle"></i> 生成结果 (可编辑)
                    </div>
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        <input type="text" id="pw-res-name" class="pw-input" placeholder="角色名称" value="${savedState.name || ''}">
                        <textarea id="pw-res-desc" class="pw-textarea" rows="8" placeholder="用户设定描述">${savedState.desc || ''}</textarea>
                        
                        <div style="background:var(--black10a); padding:8px; border-radius:6px; border:1px solid var(--SmartThemeBorderColor);">
                            <div style="display:flex; align-items:center; gap:5px; margin-bottom:5px;">
                                <input type="checkbox" id="pw-wi-toggle" checked>
                                <span style="font-size:0.9em; font-weight:bold;">同步写入世界书</span>
                            </div>
                            <textarea id="pw-res-wi" class="pw-textarea" rows="3" placeholder="世界书条目内容...">${savedState.wiContent || ''}</textarea>
                        </div>
                    </div>
                    <button id="pw-btn-apply" class="pw-btn save" style="margin-top:10px;"><i class="fa-solid fa-check"></i> 保存并切换</button>
                </div>
            </div>
        </div>

        <!-- 2. 世界书视图 -->
        <div id="pw-view-context" class="pw-view">
            <div class="pw-scroll-area">
                <div class="pw-label">添加参考世界书</div>
                <div class="pw-wi-controls">
                    <select id="pw-wi-select" class="pw-input" style="flex:1;">
                        <option value="">-- 选择世界书 --</option>
                        ${wiOptions}
                    </select>
                    <button id="pw-wi-add" class="pw-btn normal"><i class="fa-solid fa-plus"></i></button>
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
                        <select id="pw-api-source" class="pw-input" style="flex:1;">
                            <option value="main" ${config.apiSource === 'main' ? 'selected' : ''}>使用主 API</option>
                            <option value="independent" ${config.apiSource === 'independent' ? 'selected' : ''}>独立 API</option>
                        </select>
                    </div>
                    
                    <div id="pw-indep-settings" style="display:${config.apiSource === 'independent' ? 'flex' : 'none'}; flex-direction:column; gap:10px;">
                        <div class="pw-row">
                            <label>URL</label>
                            <input type="text" id="pw-api-url" class="pw-input" style="flex:1;" value="${config.indepApiUrl}" placeholder="https://api.openai.com/v1">
                        </div>
                        <div class="pw-row">
                            <label>Key</label>
                            <input type="password" id="pw-api-key" class="pw-input" style="flex:1;" value="${config.indepApiKey}">
                        </div>
                        <div class="pw-row">
                            <label>Model</label>
                            <div style="flex:1; display:flex; gap:5px;">
                                <input type="text" id="pw-api-model" class="pw-input" value="${config.indepApiModel}" list="pw-model-list" style="flex:1;">
                                <datalist id="pw-model-list"></datalist>
                                <button id="pw-api-fetch" class="pw-btn normal" title="获取模型列表"><i class="fa-solid fa-cloud-download-alt"></i></button>
                            </div>
                        </div>
                    </div>
                    <div style="text-align:right; margin-top:10px; display:flex; gap:10px; justify-content:flex-end;">
                        <button id="pw-api-test" class="pw-btn info"><i class="fa-solid fa-bolt"></i> 测试连接</button>
                        <button id="pw-api-save" class="pw-btn primary"><i class="fa-solid fa-save"></i> 保存设置</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- 4. 历史视图 -->
        <div id="pw-view-history" class="pw-view">
            <div class="pw-scroll-area">
                <div class="pw-history-toolbar">
                    <div class="pw-search-wrapper">
                        <input type="text" id="pw-history-search" class="pw-history-search" placeholder="🔍 搜索 (标题/内容/角色/时间)...">
                        <i class="fa-solid fa-times pw-search-clear"></i>
                    </div>
                    <div id="pw-history-clear-all" class="pw-history-clear-btn" title="清空所有记录">
                        <i class="fa-solid fa-trash-alt"></i>
                    </div>
                </div>
                <div id="pw-history-list" style="display:flex; flex-direction:column;"></div>
            </div>
        </div>
    </div>
    `;

    callPopup(html, 'text', '', { wide: true, large: true, okButton: "关闭" });

    // ========================================================================
    // 逻辑绑定 (保持你原有的逻辑，仅粘贴关键部分以确保完整)
    // ========================================================================
    
    // 1. 状态保存
    const saveCurrentState = () => {
        saveState({
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
                extraBooks: window.pwExtraBooks || []
            }
        });
    };
    $(document).off('.pw');
    $(document).on('input.pw change.pw', '#pw-request, #pw-res-name, #pw-res-desc, #pw-res-wi, .pw-input', saveCurrentState);

    // 2. Tab 切换
    $(document).on('click.pw', '.pw-tab', function() {
        $('.pw-tab').removeClass('active');
        $(this).addClass('active');
        $('.pw-view').removeClass('active');
        const tab = $(this).data('tab');
        $(`#pw-view-${tab}`).addClass('active');
        if(tab === 'history') renderHistoryList(); 
    });

    // 3. 标签系统 (包含编辑/删除 Popup)
    $(document).on('click.pw', '.pw-tag-add', function(e) {
        e.stopPropagation();
        const name = prompt("请输入标签名称:", "新标签");
        if (name) {
            const val = prompt("请输入默认预填内容 (可选):", "");
            tagsCache.push({ name: name, value: val || "" });
            saveData();
            $('#pw-tags-list').html(renderTags());
        }
    });

    $(document).on('click.pw', '.pw-tag:not(.pw-tag-add)', function(e) {
        e.preventDefault(); e.stopPropagation();
        const idx = $(this).data('idx');
        const tag = tagsCache[idx];

        if (isTagEditMode) {
            const editHtml = `
                <div style="display:flex; flex-direction:column; gap:10px;">
                    <label>标签名称</label>
                    <input id="pw-edit-tag-name" class="pw-input" value="${tag.name}">
                    <label>预填内容</label>
                    <input id="pw-edit-tag-val" class="pw-input" value="${tag.value}">
                </div>
            `;
            callPopup(editHtml, 'confirm', '编辑标签', { okButton: "保存", cancelButton: "取消" }).then(accept => {
                if (accept) {
                    tagsCache[idx].name = $('#pw-edit-tag-name').val();
                    tagsCache[idx].value = $('#pw-edit-tag-val').val();
                    saveData();
                    $('#pw-tags-list').html(renderTags());
                }
            });
            setTimeout(() => {
                $('.extensions_popup_text').append(`
                    <div style="margin-top:15px; text-align:right;">
                        <span id="pw-tag-delete-btn" style="color:#ff6b6b; cursor:pointer; text-decoration:underline;">🗑️ 删除此标签</span>
                    </div>
                `);
                $('#pw-tag-delete-btn').on('click', () => {
                    if(confirm("确定删除？")) {
                        tagsCache.splice(idx, 1);
                        saveData();
                        $('#pw-tags-list').html(renderTags());
                        $('.popup_close').click(); 
                    }
                });
            }, 100);
        } else {
            const $text = $('#pw-request');
            const cur = $text.val();
            const insert = tag.value ? `${tag.name}: ${tag.value}` : `${tag.name}: `;
            const prefix = (cur && !cur.endsWith('\n')) ? '\n' : '';
            $text.val(cur + prefix + insert).focus();
            $text[0].scrollTop = $text[0].scrollHeight;
            saveCurrentState();
        }
    });

    $('.pw-tags-edit-btn').on('click', function() {
        isTagEditMode = !isTagEditMode;
        $(this).toggleClass('active', isTagEditMode);
        $('#pw-tags-list').html(renderTags());
        if(isTagEditMode) toastr.info("已进入标签编辑模式，点击标签进行修改/删除");
    });

    // 4. 世界书逻辑 (复用你原有的代码逻辑)
    window.pwExtraBooks = savedState.localConfig?.extraBooks || [];
    const renderWiBooks = async () => {
        // ... (此处逻辑与你原代码一致，省略以节省空间，直接使用原逻辑即可) ...
        const container = $('#pw-wi-container').empty();
        const baseBooks = await getContextWorldBooks();
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
                            ${!isBound ? '<i class="fa-solid fa-times remove-book" style="color:#ff6b6b;" title="移除"></i>' : ''}
                            <i class="fa-solid fa-chevron-down arrow"></i>
                        </div>
                    </div>
                    <div class="pw-wi-list" data-book="${book}"></div>
                </div>
            `);
            
            $el.find('.remove-book').on('click', (e) => {
                e.stopPropagation();
                window.pwExtraBooks = window.pwExtraBooks.filter(b => b !== book);
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
                                    <div class="pw-wi-item-top">
                                        <input type="checkbox" class="pw-wi-check" ${isChecked} data-content="${encodeURIComponent(entry.content)}">
                                        <span style="font-weight:bold;flex:1;">${entry.displayName}</span>
                                        <i class="fa-solid fa-eye pw-expand-btn" title="预览"></i>
                                    </div>
                                    <div class="pw-wi-content" style="display:none;">${entry.content}</div>
                                </div>
                            `);
                            $item.find('.pw-expand-btn').on('click', function() {
                                const $content = $(this).closest('.pw-wi-item').find('.pw-wi-content');
                                if ($content.is(':visible')) {
                                    $content.slideUp();
                                    $(this).css('color', '');
                                } else {
                                    $content.slideDown();
                                    $(this).css('color', 'var(--SmartThemeQuoteColor)');
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
    renderWiBooks();

    $('#pw-wi-add').on('click', () => {
        const val = $('#pw-wi-select').val();
        if (val && !window.pwExtraBooks.includes(val)) {
            window.pwExtraBooks.push(val);
            renderWiBooks();
        }
    });

    // 5. API 设置
    $('#pw-api-source').on('change', function() { $('#pw-indep-settings').toggle($(this).val() === 'independent'); });
    $('#pw-api-fetch').on('click', async function() {
        const btn = $(this);
        btn.html('<i class="fas fa-spinner fa-spin"></i>');
        const models = await fetchModels($('#pw-api-url').val(), $('#pw-api-key').val());
        btn.html('<i class="fa-solid fa-cloud-download-alt"></i>');
        if (models.length) {
            const list = $('#pw-model-list').empty();
            models.forEach(m => list.append(`<option value="${m}">`));
            toastr.success(TEXT.TOAST_API_OK);
        } else {
            toastr.error(TEXT.TOAST_API_ERR);
        }
    });
    $('#pw-api-test').on('click', testApiConnection);
    $('#pw-api-save').on('click', () => { saveCurrentState(); toastr.success(TEXT.TOAST_SAVE_API); });

    // 6. 底部工具栏
    $('#pw-clear').on('click', () => { if(confirm("清空输入内容？")) { $('#pw-request').val(''); $('#pw-result-area').hide(); saveCurrentState(); } });
    $('#pw-snapshot').on('click', () => {
        const req = $('#pw-request').val();
        const curName = $('#pw-res-name').val();
        if (!req && !curName) return;
        saveHistory({ request: req || "无请求内容", data: { name: curName || "", description: $('#pw-res-desc').val() || "", wi_entry: $('#pw-res-wi').val() } });
        toastr.success(TEXT.TOAST_SNAPSHOT);
    });

    // 7. 生成 (Logic)
    $('#pw-btn-gen').on('click', async function() {
        const req = $('#pw-request').val();
        const curName = $('#pw-res-name').val();
        const curDesc = $('#pw-res-desc').val();
        let fullReq = req;
        if (curName || curDesc) fullReq += `\n\n[Previous Draft]:\nName: ${curName}\nDesc: ${curDesc}`;

        const $btn = $(this);
        const oldText = $btn.html();
        $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 处理中...');

        const wiContext = [];
        $('.pw-wi-check:checked').each(function() { wiContext.push(decodeURIComponent($(this).data('content'))); });

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

    // 8. 应用 (Apply)
    $('#pw-btn-apply').on('click', async function() {
        const name = $('#pw-res-name').val();
        const desc = $('#pw-res-desc').val();
        const wiContent = $('#pw-res-wi').val();
        if (!name) return toastr.warning("名字不能为空");
        
        const context = getContext();
        if (!context.powerUserSettings.personas) context.powerUserSettings.personas = {};
        context.powerUserSettings.personas[name] = desc;
        await saveSettingsDebounced();

        if ($('#pw-wi-toggle').is(':checked') && wiContent) {
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

    // 9. 历史管理
    const renderHistoryList = () => {
        loadData();
        const $list = $('#pw-history-list').empty();
        const search = $('#pw-history-search').val().toLowerCase();

        const filtered = historyCache.filter(item => {
            if (!search) return true;
            const term = search;
            const title = (item.data.customTitle || item.data.name || "").toLowerCase();
            const content = (item.data.description || "").toLowerCase();
            return title.includes(term) || content.includes(term);
        });

        if (filtered.length === 0) {
            $list.html('<div style="text-align:center; opacity:0.6; padding:20px;">暂无历史记录</div>');
            return;
        }

        filtered.forEach((item, index) => {
            const displayTitle = item.data.customTitle || item.data.name || "未命名";
            const $el = $(`
                <div class="pw-history-item">
                    <div class="pw-hist-content">
                        <div class="pw-hist-header">
                            <input class="pw-hist-title" value="${displayTitle}" readonly>
                            <i class="fa-solid fa-pencil pw-hist-edit-icon" title="编辑标题"></i>
                        </div>
                        <div class="pw-hist-meta">
                            <span><i class="fa-regular fa-clock"></i> ${item.timestamp}</span>
                            <span><i class="fa-solid fa-user-tag"></i> ${item.targetChar || '未知'}</span>
                        </div>
                        <div class="pw-hist-desc">${item.data.description || item.request || '无描述'}</div>
                    </div>
                    <div class="pw-hist-actions">
                        <div class="pw-hist-del" title="删除"><i class="fa-solid fa-trash"></i></div>
                    </div>
                </div>
            `);

            $el.on('click', function(e) {
                if ($(e.target).closest('.pw-hist-del, .pw-hist-edit-icon, input').length) return;
                $('#pw-request').val(item.request);
                $('#pw-res-name').val(item.data.name);
                $('#pw-res-desc').val(item.data.description);
                $('#pw-res-wi').val(item.data.wi_entry);
                $('#pw-result-area').show();
                $('.pw-tab[data-tab="editor"]').click();
            });

            const $titleInput = $el.find('.pw-hist-title');
            $el.find('.pw-hist-edit-icon').on('click', function(e) {
                e.stopPropagation();
                if ($titleInput.attr('readonly')) {
                    $titleInput.removeAttr('readonly').addClass('editing').focus();
                } else {
                    $titleInput.attr('readonly', true).removeClass('editing');
                    const realIndex = historyCache.indexOf(item);
                    if (realIndex > -1) updateHistoryTitle(realIndex, $titleInput.val());
                }
            });
            $titleInput.on('blur keydown', function(e) {
                if (e.type === 'keydown' && e.key !== 'Enter') return;
                if (!$titleInput.attr('readonly')) {
                    $titleInput.attr('readonly', true).removeClass('editing');
                    const realIndex = historyCache.indexOf(item);
                    if (realIndex > -1) updateHistoryTitle(realIndex, $titleInput.val());
                }
            });

            $el.find('.pw-hist-del').on('click', function(e) {
                e.stopPropagation();
                if(confirm(`确定删除 "${displayTitle}" 吗？`)) {
                    const realIndex = historyCache.indexOf(item);
                    if (realIndex > -1) {
                        historyCache.splice(realIndex, 1);
                        saveData();
                        renderHistoryList();
                    }
                }
            });

            $list.append($el);
        });
    };
    $(document).on('input.pw', '#pw-history-search', renderHistoryList);
    $(document).on('click.pw', '.pw-search-clear', function() { $('#pw-history-search').val('').trigger('input'); });
    $(document).on('click.pw', '#pw-history-clear-all', function() {
        if (historyCache.length === 0) return;
        if(confirm("确定要清空所有历史记录吗？")) { historyCache = []; saveData(); renderHistoryList(); }
    });
}

// ============================================================================
// 初始化
// ============================================================================

jQuery(async () => {
    loadCSS();
    
    // 添加到扩展设置侧边栏
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
    console.log(`${extensionName} v10 loaded.`);
});
