import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, callPopup, getRequestHeaders } from "../../../../script.js";

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const extensionName = "st-persona-weaver";
const STORAGE_KEY_HISTORY = 'pw_generation_history_v1';
const STORAGE_KEY_STATE = 'pw_current_state_v4';

const DEFAULT_TAGS = ["姓名", "年龄", "性别", "身高", "体重", "职业", "性格", "外貌", "发色", "瞳色", "穿搭", "MBTI", "星座", "特殊能力", "过往经历", "与主角关系"];
const DEFAULT_TEMPLATE = `姓名：
年龄：
职业/身份：
外貌特征：
性格特点：
与当前角色的关系：
特殊能力/背景：`;

const defaultSettings = {
    autoSwitchPersona: true,
    syncToWorldInfo: true,
    historyLimit: 10,
    defaultOutputFormat: 'list',
    
    // Custom Template & Tags
    customTemplate: DEFAULT_TEMPLATE,
    customTags: DEFAULT_TAGS,
    
    // Independent API Settings
    apiSource: 'main', 
    customApiUrl: 'https://api.openai.com/v1',
    customApiKey: '',
    customApiModel: 'gpt-3.5-turbo'
};

// UI Text Constants
const TEXT = {
    PANEL_TITLE: "用户设定编织者 ✒️",
    BTN_OPEN_MAIN: "✨ 打开设定生成器",
    BTN_OPEN_DESC: "AI 辅助生成用户人设、属性表并深度管理世界书",
    
    LBL_AUTO_SWITCH: "保存后自动切换马甲",
    LBL_SYNC_WI: "默认勾选同步世界书",
    LBL_API_SOURCE: "AI 生成源",
    
    TOAST_NO_CHAR: "请先打开一个角色聊天",
    TOAST_GEN_FAIL: "生成失败，请检查 API 设置",
    TOAST_SAVE_SUCCESS: (name) => `已保存并切换为: ${name}`,
    TOAST_WI_SUCCESS: (book) => `已写入世界书: ${book}`,
    TOAST_ENTRY_UPDATED: "条目状态已更新",
    
    LBL_SELECT_WB: "目标世界书",
    BTN_MANAGE_ENTRIES: "管理条目"
};

// ============================================================================
// STATE & UTILS
// ============================================================================

let historyCache = [];

function loadHistory() {
    try {
        historyCache = JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY)) || [];
    } catch { historyCache = []; }
}

function saveHistory(item) {
    item.timestamp = new Date().toLocaleString();
    historyCache.unshift(item);
    if (historyCache.length > extension_settings[extensionName].historyLimit) {
        historyCache = historyCache.slice(0, extension_settings[extensionName].historyLimit);
    }
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(historyCache));
}

function saveState(data) {
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(data));
}

function loadState() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY_STATE)) || {};
    } catch { return {}; }
}

function insertAtCursor(myField, myValue) {
    // IE support
    if (document.selection) {
        myField.focus();
        sel = document.selection.createRange();
        sel.text = myValue;
    }
    // MOZILLA and others
    else if (myField.selectionStart || myField.selectionStart == '0') {
        var startPos = myField.selectionStart;
        var endPos = myField.selectionEnd;
        myField.value = myField.value.substring(0, startPos)
            + myValue
            + myField.value.substring(endPos, myField.value.length);
        myField.selectionStart = startPos + myValue.length;
        myField.selectionEnd = startPos + myValue.length;
    } else {
        myField.value += myValue;
    }
    $(myField).trigger('input'); // Save state
}

function injectStyles() {
    const styleId = 'persona-weaver-css';
    if ($(`#${styleId}`).length) return;

    const css = `
    .pw-wrapper { display: flex; flex-direction: column; height: 100%; text-align: left; font-size: 0.95em; min-height: 500px; }
    .pw-header { padding: 12px; border-bottom: 1px solid var(--SmartThemeBorderColor); display: flex; justify-content: space-between; align-items: center; background: var(--SmartThemeBg); }
    .pw-title { font-weight: bold; font-size: 1.1em; display: flex; align-items: center; gap: 8px; }
    .pw-tools i { cursor: pointer; margin-left: 15px; opacity: 0.7; transition: 0.2s; font-size: 1.1em; }
    .pw-tools i:hover { opacity: 1; transform: scale(1.1); color: var(--SmartThemeQuoteColor); }
    
    .pw-scroll-area { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 15px; }
    
    .pw-section { display: flex; flex-direction: column; gap: 8px; }
    .pw-label { font-size: 0.85em; opacity: 0.8; font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
    
    .pw-input-tools { display: flex; gap: 10px; margin-bottom: 5px; font-size: 0.85em; align-items: center; }
    .pw-text-btn { cursor: pointer; color: var(--SmartThemeQuoteColor); font-weight: bold; opacity: 0.9; text-decoration: underline; }
    .pw-text-btn:hover { opacity: 1; }

    /* Tag Chips */
    .pw-tags-container { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
    .pw-tag { background: var(--black30a); border: 1px solid var(--SmartThemeBorderColor); border-radius: 12px; padding: 2px 10px; font-size: 0.85em; cursor: pointer; transition: 0.2s; user-select: none; }
    .pw-tag:hover { background: var(--SmartThemeQuoteColor); color: white; border-color: var(--SmartThemeQuoteColor); }
    .pw-tag.deletable:hover { background: var(--SmartThemeColorRed); border-color: var(--SmartThemeColorRed); }

    .pw-textarea { width: 100%; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); color: var(--SmartThemeBodyColor); border-radius: 6px; padding: 10px; resize: vertical; min-height: 100px; box-sizing: border-box; line-height: 1.5; font-family: inherit; }
    .pw-textarea:focus { outline: 2px solid var(--SmartThemeQuoteColor); border-color: transparent; }
    
    .pw-input { width: 100%; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); color: var(--SmartThemeBodyColor); padding: 8px; border-radius: 6px; box-sizing: border-box; }
    .pw-select { width: 100%; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); color: var(--SmartThemeBodyColor); padding: 8px; border-radius: 6px; box-sizing: border-box; cursor: pointer; flex: 1; }
    
    .pw-card { background: var(--black10a); border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
    
    .pw-btn { border: none; padding: 10px; border-radius: 6px; font-weight: bold; cursor: pointer; color: white; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; transition: 0.2s; }
    .pw-btn:hover { filter: brightness(1.1); transform: translateY(-1px); }
    .pw-btn.gen { background: var(--SmartThemeQuoteColor); margin-top: 5px; }
    .pw-btn.save { background: var(--SmartThemeEmColor); }
    .pw-btn.neutral { background: var(--black50a); border: 1px solid var(--SmartThemeBorderColor); width: auto; padding: 6px 12px; font-size: 0.9em; }
    .pw-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; filter: grayscale(0.5); }

    /* World Info Entry Management */
    .pw-wi-toolbar { display: flex; gap: 8px; margin-bottom: 10px; }
    .pw-wi-search { flex: 1; }
    .pw-entry-list { max-height: 300px; overflow-y: auto; border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; background: var(--black10a); }
    .pw-entry-item { display: flex; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--SmartThemeBorderColor); gap: 10px; cursor: pointer; transition: 0.2s; }
    .pw-entry-item:last-child { border-bottom: none; }
    .pw-entry-item:hover { background: var(--white10a); }
    .pw-entry-check { transform: scale(1.2); cursor: pointer; }
    .pw-entry-name { flex: 1; font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pw-entry-keys { font-size: 0.8em; opacity: 0.6; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .pw-view { display: none; flex-direction: column; flex: 1; min-height: 0; }
    .pw-view.active { display: flex; }
    `;
    $('<style>').attr('id', styleId).html(css).appendTo('head');
}

// ============================================================================
// CORE LOGIC
// ============================================================================

// 获取所有世界书
async function getAllWorldBooks() {
    try {
        const headers = getRequestHeaders();
        const response = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({}) });
        if (response.ok) {
            const data = await response.json();
            return data.map(item => (typeof item === 'object' ? item.name : item)).sort();
        }
    } catch (e) {
        console.error("Failed to fetch world books", e);
    }
    return [];
}

// 获取世界书内容 (包括条目)
async function getWorldBookData(name) {
    try {
        const headers = getRequestHeaders();
        const response = await fetch('/api/worldinfo/get', { 
            method: 'POST', headers, body: JSON.stringify({ name: name }) 
        });
        if (response.ok) {
            return await response.json();
        }
    } catch (e) {
        console.error(`Failed to fetch book ${name}`, e);
    }
    return null;
}

// 更新世界书 (全量更新)
async function updateWorldBook(name, data) {
    try {
        const headers = getRequestHeaders();
        await fetch('/api/worldinfo/edit', {
            method: 'POST', headers, body: JSON.stringify({ name: name, data: data })
        });
        return true;
    } catch (e) {
        console.error(`Failed to update book ${name}`, e);
        return false;
    }
}

// 获取当前上下文推荐的世界书
async function getRecommendedWorldBook() {
    const context = getContext();
    if (context.chatMetadata && context.chatMetadata.world_info) return context.chatMetadata.world_info;
    const charId = context.characterId;
    if (charId !== undefined && context.characters[charId]) {
        const char = context.characters[charId];
        const data = char.data || char;
        const world = data.extensions?.world || data.world || data.character_book?.name;
        if (world && typeof world === 'string') return world;
    }
    return null;
}

// Custom API Call
async function callCustomApi(messages) {
    const settings = extension_settings[extensionName];
    const url = settings.customApiUrl.replace(/\/$/, '') + '/chat/completions';
    
    const body = {
        model: settings.customApiModel,
        messages: messages,
        temperature: 0.7,
        max_tokens: 1000
    };

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.customApiKey}`
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Custom API Error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

async function generatePersona(userRequest, outputFormat = 'list') {
    const context = getContext();
    const charId = context.characterId;
    if (charId === undefined) throw new Error("No character selected");
    
    const char = context.characters[charId];
    const settings = extension_settings[extensionName];
    
    let formatInst = "";
    if (outputFormat === 'list') {
        formatInst = `"description": "Output strictly as an Attribute List / Character Sheet format. Use newlines. Example:\\nName: ...\\nAge: ...\\nAppearance: ...\\nPersonality: ...\\nBackground: ...\\n\\n(Ensure content is detailed, approx 200 words total)"`;
    } else {
        formatInst = `"description": "Output as a narrative, descriptive paragraph in third person. (Approx 200 words)"`;
    }

    const systemPrompt = `Task: Create a User Persona based on the user's request and the current character's context.
Current Character: ${char.name}
Scenario: ${char.scenario || "None"}

Return ONLY a JSON object with this format:
{
    "name": "Name of the persona",
    ${formatInst},
    "wi_entry": "Background facts about this persona suitable for World Info/Lorebook (Key facts only)."
}`;

    const userPrompt = `User Request/Profile:\n${userRequest}`;

    try {
        let generatedText = "";
        if (settings.apiSource === 'custom' && settings.customApiKey) {
            console.log("[PersonaWeaver] Using Custom API");
            const messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }];
            generatedText = await callCustomApi(messages);
        } else {
            console.log("[PersonaWeaver] Using Main API");
            const combinedPrompt = systemPrompt + "\n\n" + userPrompt;
            generatedText = await context.generateQuietPrompt(combinedPrompt, false, false, "System");
        }

        const jsonMatch = generatedText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Failed to parse JSON from AI response: " + generatedText);
        return JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.error("Persona Weaver Generation Error:", e);
        throw e;
    }
}

// ============================================================================
// UI FUNCTIONS
// ============================================================================

async function openCreatorPopup() {
    const context = getContext();
    if (context.characterId === undefined) {
        toastr.warning(TEXT.TOAST_NO_CHAR, TEXT.PANEL_TITLE);
        return;
    }

    loadHistory();
    const savedState = loadState();
    
    // Prepare Data
    const allBooks = await getAllWorldBooks();
    const recommendedBook = await getRecommendedWorldBook();
    const selectedBook = savedState.selectedBook || recommendedBook || (allBooks.length > 0 ? allBooks[0] : "");
    const tags = extension_settings[extensionName].customTags || DEFAULT_TAGS;
    
    // Build Tag Chips
    const tagsHtml = tags.map(tag => `<div class="pw-tag" data-tag="${tag}">${tag}</div>`).join('');

    // Build Select Options
    let optionsHtml = allBooks.map(b => 
        `<option value="${b}" ${b === selectedBook ? 'selected' : ''}>${b}${b === recommendedBook ? ' (当前)' : ''}</option>`
    ).join('');
    if (allBooks.length === 0) optionsHtml = `<option value="" disabled selected>无可用世界书</option>`;

    // Template Check
    let currentFormat = savedState.format || extension_settings[extensionName].defaultOutputFormat || 'list';

    const html = `
    <div class="pw-wrapper">
        <div class="pw-header">
            <div class="pw-title"><i class="fa-solid fa-wand-magic-sparkles"></i> 设定构思</div>
            <div class="pw-tools">
                <i class="fa-solid fa-eraser" id="pw-clear" title="清空内容"></i>
                <i class="fa-solid fa-clock-rotate-left" id="pw-history" title="历史记录"></i>
            </div>
        </div>

        <!-- Editor View -->
        <div id="pw-view-editor" class="pw-view active">
            <div class="pw-scroll-area">
                
                <!-- Input Section -->
                <div class="pw-section">
                    <div class="pw-label">
                        <span>设定填空 / 快速标签</span>
                        <div class="pw-input-tools">
                            <span class="pw-text-btn" id="pw-fill-template"><i class="fa-solid fa-file-invoice"></i> 插入模板</span>
                        </div>
                    </div>
                    
                    <div class="pw-tags-container">
                        ${tagsHtml}
                    </div>

                    <textarea id="pw-request" class="pw-textarea" placeholder="点击上方标签可快速插入，或直接输入要求...">${savedState.request || ''}</textarea>
                    
                    <div class="pw-label" style="margin-top:5px;">生成结果格式</div>
                    <div class="pw-fmt-toggle">
                        <div class="pw-fmt-opt ${currentFormat === 'list' ? 'active' : ''}" data-fmt="list">
                            <i class="fa-solid fa-list-ul"></i> 属性表 (推荐)
                        </div>
                        <div class="pw-fmt-opt ${currentFormat === 'paragraph' ? 'active' : ''}" data-fmt="paragraph">
                            <i class="fa-solid fa-paragraph"></i> 小说段落
                        </div>
                    </div>

                    <button id="pw-btn-gen" class="pw-btn gen"><i class="fa-solid fa-bolt"></i> AI 生成 / 润色</button>
                </div>

                <!-- Result Section -->
                <div id="pw-result-area" style="display: ${savedState.hasResult ? 'block' : 'none'}">
                    <div style="border-top: 1px dashed var(--SmartThemeBorderColor); margin: 5px 0 15px 0;"></div>
                    <div class="pw-label"><i class="fa-solid fa-check-circle"></i> 结果确认</div>
                    
                    <div class="pw-card">
                        <div>
                            <span class="pw-label">角色名称 (Name)</span>
                            <input type="text" id="pw-res-name" class="pw-input" value="${savedState.name || ''}">
                        </div>
                        <div>
                            <span class="pw-label">用户设定 (Description)</span>
                            <textarea id="pw-res-desc" class="pw-textarea" rows="6">${savedState.desc || ''}</textarea>
                        </div>
                        
                        <div style="background: var(--black10a); padding: 8px; border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor);">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                                <input type="checkbox" id="pw-wi-toggle" ${extension_settings[extensionName].syncToWorldInfo ? 'checked' : ''}>
                                <label for="pw-wi-toggle" style="font-size: 0.9em; cursor: pointer; font-weight:bold;">同步写入世界书</label>
                            </div>
                            
                            <div id="pw-wi-container">
                                <span class="pw-label" style="margin-bottom:2px;">${TEXT.LBL_SELECT_WB}</span>
                                <div style="display:flex; gap:5px;">
                                    <select id="pw-wi-select" class="pw-select">${optionsHtml}</select>
                                    <button id="pw-btn-manage-entries" class="pw-btn neutral" title="${TEXT.BTN_MANAGE_ENTRIES}"><i class="fa-solid fa-gear"></i></button>
                                </div>
                                <textarea id="pw-res-wi" class="pw-textarea" rows="3" placeholder="世界书条目内容..." style="margin-top:8px;">${savedState.wiContent || ''}</textarea>
                            </div>
                        </div>
                    </div>

                    <button id="pw-btn-save" class="pw-btn save"><i class="fa-solid fa-floppy-disk"></i> 保存并启用</button>
                </div>
            </div>
        </div>

        <!-- WI Entries Management View -->
        <div id="pw-view-wi-entries" class="pw-view">
            <div class="pw-header" style="background: var(--black10a);">
                <div class="pw-title"><i class="fa-solid fa-book"></i> 管理条目: <span id="pw-wi-name-display" style="opacity:0.8;"></span></div>
            </div>
            <div class="pw-scroll-area">
                <div class="pw-wi-toolbar">
                    <input type="text" id="pw-entry-search" class="pw-input pw-wi-search" placeholder="搜索条目...">
                    <button id="pw-entry-select-all" class="pw-btn neutral" style="width:auto;">全选</button>
                    <button id="pw-entry-deselect-all" class="pw-btn neutral" style="width:auto;">全不选</button>
                </div>
                <div id="pw-entry-list-container" class="pw-entry-list">
                    <div style="padding:20px; text-align:center; opacity:0.6;"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>
                </div>
            </div>
            <div style="padding: 10px; border-top: 1px solid var(--SmartThemeBorderColor); text-align: center;">
                <button id="pw-btn-back-main" class="pw-btn neutral"><i class="fa-solid fa-arrow-left"></i> 返回</button>
            </div>
        </div>

        <!-- History View -->
        <div id="pw-view-history" class="pw-view">
            <div class="pw-scroll-area" id="pw-history-list"></div>
            <div style="padding: 15px; border-top: 1px solid var(--SmartThemeBorderColor); text-align: center;">
                <button id="pw-btn-back" class="pw-btn neutral" style="display:inline-flex;"><i class="fa-solid fa-arrow-left"></i> 返回编辑</button>
            </div>
        </div>
    </div>
    `;

    callPopup(html, 'text', '', { wide: true, large: true, okButton: "关闭" });
}

// ============================================================================
// WI ENTRIES MANAGEMENT
// ============================================================================

let currentBookData = null; // Store current book data in memory

async function renderEntryList(bookName, searchTerm = "") {
    const $container = $('#pw-entry-list-container');
    $container.html('<div style="padding:20px; text-align:center; opacity:0.6;"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>');
    
    // Fetch if not in memory or name changed (simple caching)
    if (!currentBookData || currentBookData.name !== bookName) {
        const data = await getWorldBookData(bookName);
        if (!data || !data.entries) {
            $container.html('<div style="padding:20px; text-align:center;">无法加载世界书数据</div>');
            return;
        }
        // Normalize name just in case
        data.name = bookName;
        currentBookData = data;
    }

    const entries = Object.values(currentBookData.entries).sort((a, b) => (a.comment || "").localeCompare(b.comment || ""));
    const filtered = entries.filter(e => {
        if (!searchTerm) return true;
        const term = searchTerm.toLowerCase();
        return (e.comment && e.comment.toLowerCase().includes(term)) || 
               (e.keys && e.keys.join(',').toLowerCase().includes(term));
    });

    if (filtered.length === 0) {
        $container.html('<div style="padding:20px; text-align:center; opacity:0.6;">没有找到条目</div>');
        return;
    }

    let html = '';
    filtered.forEach(entry => {
        html += `
        <div class="pw-entry-item" data-uid="${entry.uid}">
            <input type="checkbox" class="pw-entry-check" ${entry.enabled ? 'checked' : ''}>
            <div class="pw-entry-name">${entry.comment || '(未命名)'}</div>
            <div class="pw-entry-keys">${Array.isArray(entry.key) ? entry.key.join(', ') : entry.key}</div>
        </div>`;
    });
    
    $container.html(html);
}

// ============================================================================
// GLOBAL EVENTS
// ============================================================================

function bindGlobalEvents() {
    $(document).off('click.pw_ext change.pw_ext input.pw_ext');

    // --- State & Inputs ---
    $(document).on('input.pw_ext change.pw_ext', '#pw-request, #pw-res-name, #pw-res-desc, #pw-res-wi, #pw-wi-toggle, #pw-wi-select', function() {
        const currentFormat = $('.pw-fmt-opt.active').data('fmt') || 'list';
        saveState({
            request: $('#pw-request').val(),
            format: currentFormat,
            hasResult: $('#pw-result-area').css('display') !== 'none',
            name: $('#pw-res-name').val(),
            desc: $('#pw-res-desc').val(),
            wiContent: $('#pw-res-wi').val(),
            selectedBook: $('#pw-wi-select').val()
        });
    });

    // --- Tag Click ---
    $(document).on('click.pw_ext', '.pw-tag', function() {
        const tagText = $(this).data('tag');
        const $textarea = $('#pw-request');
        insertAtCursor($textarea[0], tagText + "：");
    });

    // --- Insert Template ---
    $(document).on('click.pw_ext', '#pw-fill-template', function() {
        const template = extension_settings[extensionName].customTemplate || DEFAULT_TEMPLATE;
        const currentVal = $('#pw-request').val();
        if (currentVal.trim() !== "" && !confirm("确定要追加模板吗？")) return;
        const newVal = currentVal ? currentVal + "\n\n" + template : template;
        $('#pw-request').val(newVal).focus().trigger('change');
    });

    // --- Generate ---
    $(document).on('click.pw_ext', '#pw-btn-gen', async function() {
        const req = $('#pw-request').val();
        if (!req.trim()) return toastr.warning("请输入要求");
        const currentFormat = $('.pw-fmt-opt.active').data('fmt') || 'list';
        const $btn = $(this);
        const oldText = $btn.html();
        $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 正在生成...');

        try {
            const data = await generatePersona(req, currentFormat);
            $('#pw-res-name').val(data.name);
            $('#pw-res-desc').val(data.description);
            $('#pw-res-wi').val(data.wi_entry || data.description);
            $('#pw-result-area').fadeIn();
            saveHistory({ request: req, format: currentFormat, data: data });
            $('#pw-request').trigger('change');
        } catch (e) {
            toastr.error(e.message || TEXT.TOAST_GEN_FAIL);
        } finally {
            $btn.prop('disabled', false).html(oldText);
        }
    });

    // --- Save ---
    $(document).on('click.pw_ext', '#pw-btn-save', async function() {
        const name = $('#pw-res-name').val();
        const desc = $('#pw-res-desc').val();
        const wiContent = $('#pw-res-wi').val();
        const syncWi = $('#pw-wi-toggle').is(':checked');
        const targetWb = $('#pw-wi-select').val();

        if (!name) return toastr.warning("名字不能为空");
        const $btn = $(this);
        $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 保存中...');

        try {
            const context = getContext();
            // 1. Persona
            if (!context.powerUserSettings.personas) context.powerUserSettings.personas = {};
            context.powerUserSettings.personas[name] = desc;
            await saveSettingsDebounced();

            // 2. World Info
            if (targetWb && syncWi && wiContent) {
                // Ensure we have latest data
                const bookData = await getWorldBookData(targetWb);
                if (bookData) {
                    if (!bookData.entries) bookData.entries = {};
                    const ids = Object.keys(bookData.entries).map(Number);
                    const newId = ids.length ? Math.max(...ids) + 1 : 0;
                    bookData.entries[newId] = {
                        uid: newId,
                        key: [name, "User", "用户"],
                        keysecondary: [],
                        comment: `[User] ${name}`,
                        content: wiContent,
                        constant: false, selective: true, enabled: true
                    };
                    await updateWorldBook(targetWb, bookData);
                    toastr.success(TEXT.TOAST_WI_SUCCESS(targetWb), TEXT.PANEL_TITLE);
                    if (context.updateWorldInfoList) context.updateWorldInfoList();
                }
            }

            // 3. Auto Switch
            if (extension_settings[extensionName].autoSwitchPersona) {
                context.powerUserSettings.persona_selected = name;
                $("#your_name").val(name).trigger("input").trigger("change");
                $("#your_desc").val(desc).trigger("input").trigger("change");
            }

            toastr.success(TEXT.TOAST_SAVE_SUCCESS(name), TEXT.PANEL_TITLE);
            $('.swal2-confirm, .swal2-cancel, .popup_close').click();
        } catch (e) {
            console.error(e);
            toastr.error("保存失败: " + e.message);
        } finally {
            $btn.prop('disabled', false).html('<i class="fa-solid fa-floppy-disk"></i> 保存并启用');
        }
    });

    // --- WI Entry Management UI ---
    $(document).on('click.pw_ext', '#pw-btn-manage-entries', async function() {
        const bookName = $('#pw-wi-select').val();
        if (!bookName) return toastr.warning("请先选择一个世界书");
        
        $('#pw-wi-name-display').text(bookName);
        $('#pw-view-editor').removeClass('active');
        $('#pw-view-wi-entries').addClass('active');
        
        // Render List
        renderEntryList(bookName);
    });

    $(document).on('click.pw_ext', '#pw-btn-back-main', function() {
        $('#pw-view-wi-entries').removeClass('active');
        $('#pw-view-editor').addClass('active');
        currentBookData = null; // Clear cache on exit
    });

    // Toggle Entry
    $(document).on('change.pw_ext', '.pw-entry-check', async function() {
        if (!currentBookData) return;
        const $item = $(this).closest('.pw-entry-item');
        const uid = $item.data('uid');
        const checked = $(this).is(':checked');
        
        // Update Local Memory
        if (currentBookData.entries[uid]) {
            currentBookData.entries[uid].enabled = checked;
            // Immediate API Update (Background)
            await updateWorldBook(currentBookData.name, currentBookData);
            // toastr.info(TEXT.TOAST_ENTRY_UPDATED); // Optional: too noisy?
        }
    });

    // Select All/None
    const batchUpdateEntries = async (enabled) => {
        if (!currentBookData) return;
        let changed = false;
        // Apply to visible/filtered entries
        $('.pw-entry-item').each(function() {
            const uid = $(this).data('uid');
            const $check = $(this).find('.pw-entry-check');
            if ($check.is(':checked') !== enabled) {
                $check.prop('checked', enabled);
                if (currentBookData.entries[uid]) {
                    currentBookData.entries[uid].enabled = enabled;
                    changed = true;
                }
            }
        });
        if (changed) {
            await updateWorldBook(currentBookData.name, currentBookData);
            toastr.success("批量更新完成");
        }
    };

    $(document).on('click.pw_ext', '#pw-entry-select-all', () => batchUpdateEntries(true));
    $(document).on('click.pw_ext', '#pw-entry-deselect-all', () => batchUpdateEntries(false));
    
    // Search Entries
    $(document).on('input.pw_ext', '#pw-entry-search', function() {
        const term = $(this).val();
        if (currentBookData) renderEntryList(currentBookData.name, term);
    });

    // --- Misc ---
    $(document).on('click.pw_ext', '#pw-clear', function() {
        if(confirm("确定清空？")) {
            $('input[type="text"], textarea').val('');
            $('#pw-result-area').hide();
            localStorage.removeItem(STORAGE_KEY_STATE);
        }
    });

    $(document).on('click.pw_ext', '.pw-fmt-opt', function() {
        $('.pw-fmt-opt').removeClass('active');
        $(this).addClass('active');
        $('#pw-request').trigger('change');
    });

    $(document).on('click.pw_ext', '#pw-history', function() {
        loadHistory();
        const $list = $('#pw-history-list').empty();
        historyCache.forEach(item => {
            const $el = $(`
                <div class="pw-history-item">
                    <div style="font-size:0.8em; opacity:0.5; margin-bottom:4px;">${item.timestamp}</div>
                    <div style="font-weight:bold; color:var(--SmartThemeQuoteColor); font-size:1.05em;">${item.data.name}</div>
                    <div style="font-size:0.9em; opacity:0.8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${item.request}</div>
                </div>`);
            $el.on('click', () => {
                $('#pw-request').val(item.request);
                $('#pw-res-name').val(item.data.name);
                $('#pw-res-desc').val(item.data.description);
                $('#pw-res-wi').val(item.data.wi_entry);
                $('.pw-fmt-opt').removeClass('active');
                $(`.pw-fmt-opt[data-fmt="${item.format||'list'}"]`).addClass('active');
                $('#pw-result-area').show();
                $('.pw-view').removeClass('active');
                $(`#pw-view-editor`).addClass('active');
            });
            $list.append($el);
        });
        $('.pw-view').removeClass('active');
        $(`#pw-view-history`).addClass('active');
    });

    $(document).on('click.pw_ext', '#pw-btn-back', function() {
        $('.pw-view').removeClass('active');
        $(`#pw-view-editor`).addClass('active');
    });
}

// ============================================================================
// SETTINGS & INIT
// ============================================================================

async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }
    // Initialize Defaults if missing
    if (!extension_settings[extensionName].customTags) extension_settings[extensionName].customTags = DEFAULT_TAGS;
    if (!extension_settings[extensionName].customTemplate) extension_settings[extensionName].customTemplate = DEFAULT_TEMPLATE;

    updateApiVisibility();
    renderTagSettings();
}

function updateApiVisibility() {
    const source = $("#pw_api_source").val();
    if (source === 'custom') $("#pw_custom_api_settings").slideDown();
    else $("#pw_custom_api_settings").slideUp();
}

function renderTagSettings() {
    const tags = extension_settings[extensionName].customTags;
    const $con = $('#pw_tags_list_setting').empty();
    tags.forEach((tag, idx) => {
        const $tag = $(`<div class="pw-tag deletable" title="点击删除">${tag}</div>`);
        $tag.on('click', () => {
            tags.splice(idx, 1);
            saveSettingsDebounced();
            renderTagSettings();
        });
        $con.append($tag);
    });
}

function onSettingChanged() {
    const s = extension_settings[extensionName];
    s.autoSwitchPersona = $("#pw_auto_switch").prop("checked");
    s.syncToWorldInfo = $("#pw_sync_wi").prop("checked");
    
    s.apiSource = $("#pw_api_source").val();
    s.customApiUrl = $("#pw_custom_url").val();
    s.customApiKey = $("#pw_custom_key").val();
    s.customApiModel = $("#pw_custom_model").val();
    
    s.customTemplate = $("#pw_custom_template").val();
    
    saveSettingsDebounced();
    updateApiVisibility();
}

jQuery(async () => {
    injectStyles();
    await loadSettings();
    bindGlobalEvents(); 

    const settingsHtml = `
    <div class="world-info-cleanup-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${TEXT.PANEL_TITLE}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div style="margin: 10px 0;">
                    <input id="pw_open_btn" class="menu_button" type="button" 
                           value="${TEXT.BTN_OPEN_MAIN}" 
                           style="width: 100%; padding: 8px; font-weight: bold; background: var(--SmartThemeQuoteColor); color: #fff;" />
                    <small style="display: block; text-align: center; opacity: 0.7; margin-top: 5px;">${TEXT.BTN_OPEN_DESC}</small>
                </div>
                <hr class="sysHR" />
                
                <!-- Tag Manager -->
                <div style="margin-bottom: 15px;">
                    <h4 style="margin:0 0 10px 0;">标签管理器 (Tag Manager)</h4>
                    <div id="pw_tags_list_setting" class="pw-tags-container" style="padding:5px; background:var(--black10a); border-radius:6px; min-height:40px;"></div>
                    <div style="display:flex; gap:5px; margin-top:5px;">
                        <input id="pw_new_tag_input" class="pw-input" placeholder="新标签名称..." style="flex:1;">
                        <button id="pw_add_tag_btn" class="menu_button" style="width:auto;"><i class="fa-solid fa-plus"></i></button>
                    </div>
                </div>
                <hr class="sysHR" />

                <!-- API Settings -->
                <div style="margin-bottom: 15px;">
                    <h4 style="margin:0 0 10px 0;">API 设置</h4>
                    <div class="pw-setting-row" style="margin-bottom:10px;">
                        <label class="pw-label">${TEXT.LBL_API_SOURCE}</label>
                        <select id="pw_api_source" class="pw-select">
                            <option value="main">酒馆主连接 (Main)</option>
                            <option value="custom">独立 API (OpenAI Compatible)</option>
                        </select>
                    </div>
                    <div id="pw_custom_api_settings" style="display:none; padding-left: 10px; border-left: 2px solid var(--SmartThemeBorderColor);">
                        <div class="pw-setting-row" style="margin-bottom:5px;">
                            <label class="pw-label">API URL</label>
                            <input id="pw_custom_url" class="pw-input" placeholder="https://api.openai.com/v1" />
                        </div>
                        <div class="pw-setting-row" style="margin-bottom:5px;">
                            <label class="pw-label">API Key</label>
                            <input id="pw_custom_key" type="password" class="pw-input" placeholder="sk-..." />
                        </div>
                        <div class="pw-setting-row">
                            <label class="pw-label">Model Name</label>
                            <input id="pw_custom_model" class="pw-input" placeholder="gpt-4o" />
                        </div>
                    </div>
                </div>
                <hr class="sysHR" />

                <!-- Basic Options -->
                <div style="margin-bottom: 10px;">
                    <div class="flex-container" style="margin: 5px 0; align-items: center;">
                        <input id="pw_auto_switch" type="checkbox" />
                        <label for="pw_auto_switch" style="margin-left: 8px;">${TEXT.LBL_AUTO_SWITCH}</label>
                    </div>
                    <div class="flex-container" style="margin: 5px 0; align-items: center;">
                        <input id="pw_sync_wi" type="checkbox" />
                        <label for="pw_sync_wi" style="margin-left: 8px;">${TEXT.LBL_SYNC_WI}</label>
                    </div>
                </div>
                
                <div style="margin-bottom: 10px;">
                    <h4 style="margin:0 0 10px 0;">自定义填写模板</h4>
                    <textarea id="pw_custom_template" class="pw-textarea" rows="6"></textarea>
                </div>
            </div>
        </div>
    </div>`;

    $("#extensions_settings2").append(settingsHtml);
    
    // Initial Values
    $("#pw_auto_switch").prop("checked", extension_settings[extensionName].autoSwitchPersona);
    $("#pw_sync_wi").prop("checked", extension_settings[extensionName].syncToWorldInfo);
    $("#pw_api_source").val(extension_settings[extensionName].apiSource || 'main');
    $("#pw_custom_url").val(extension_settings[extensionName].customApiUrl);
    $("#pw_custom_key").val(extension_settings[extensionName].customApiKey);
    $("#pw_custom_model").val(extension_settings[extensionName].customApiModel);
    $("#pw_custom_template").val(extension_settings[extensionName].customTemplate);

    // Bind Settings Events
    $("#pw_open_btn").on("click", openCreatorPopup);
    $("#pw_auto_switch, #pw_sync_wi").on("change", onSettingChanged);
    $("#pw_api_source, #pw_custom_url, #pw_custom_key, #pw_custom_model").on("change", onSettingChanged);
    $("#pw_custom_template").on("change", onSettingChanged);
    
    // Tag Manager Add
    $("#pw_add_tag_btn").on("click", () => {
        const val = $("#pw_new_tag_input").val().trim();
        if (val) {
            extension_settings[extensionName].customTags.push(val);
            saveSettingsDebounced();
            renderTagSettings();
            $("#pw_new_tag_input").val("");
        }
    });

    console.log(`${extensionName} loaded.`);
});
