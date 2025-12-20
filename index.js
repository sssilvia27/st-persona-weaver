import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, callPopup, getRequestHeaders } from "../../../../script.js";

const extensionName = "st-persona-weaver";
const STORAGE_KEY_HISTORY = 'pw_history_v20';
const STORAGE_KEY_STATE = 'pw_state_v20'; 
const STORAGE_KEY_TEMPLATE = 'pw_template_v22'; // 模版版本更新
const STORAGE_KEY_PROMPTS = 'pw_prompts_v1';
const BUTTON_ID = 'pw_persona_tool_btn';

// [需求1] 全新的中文模版 (YAML 格式)
const defaultTemplate = 
`basic_info:
  Nickname: 
  age: 
  gender: 
  height: 
  identity:
    - 
  background_story:
    童年(0-12岁):
    少年(13-18岁):
    青年(19-35岁):
    中年(35-至今):
    现状:
  
  social_status: 
    - 

  appearance:
    hair: 
    eyes: 
    skin:
    face_style: 
    build: 
      - 
  attire:
    business_formal:
    business_casual:
    casual_wear:
    home_wear:

  archetype: 

  personality:
    core_traits: 
      - : ""
    romantic_traits: 
      - : ""
       

  lifestyle_behaviors:
    - 
    - 
  
  work_behaviors:
    - 
  
  emotional_behaviors:
    angry:
    happy: 

  goals:
    - 
  
  weakness:
    - 

  likes:
    - 

  dislikes:
    - 
  
  skills:
    - 工作: ["",""]
    - 生活: ["",""]
    - 爱好: ["",""]

  NSFW_information:
    Sex_related traits:
      experiences: 
      sexual_orientation: 
      sexual_role: 
      sexual_habits: 
        - 
    Kinks: 
    Limits:`;

const defaultSystemPromptInitial = 
`Creating User Persona for {{user}} (Target: {{char}}).
{{wi}}
User Requirement: {{input}}
Task: Generate character details strictly following the format below. Do NOT change the keys.
Format Template:
{{template}}
Response: ONLY the filled YAML content.`;

const defaultSystemPromptRefine = 
`Optimizing User Persona for {{char}}.
{{wi}}
[Current Data]:
"""{{current}}"""
[Instruction]: "{{input}}"
Task: Modify the data based on instruction. If text is quoted, focus on that part. Maintain the YAML structure.
Response: ONLY the modified full content.`;

const defaultSettings = {
    autoSwitchPersona: true, syncToWorldInfo: false,
    historyLimit: 50, apiSource: 'main', 
    indepApiUrl: 'https://api.openai.com/v1', indepApiKey: '', indepApiModel: 'gpt-3.5-turbo'
};

const TEXT = {
    PANEL_TITLE: "用户设定编织者 Pro",
    BTN_TITLE: "打开设定生成器",
    TOAST_SAVE_SUCCESS: (name) => `Persona "${name}" 已保存并覆盖！`,
    TOAST_WI_SUCCESS: (book) => `已实时更新世界书: ${book}`,
    TOAST_WI_FAIL: "当前角色未绑定世界书，无法同步",
    TOAST_WI_ERROR: "TavernHelper API 未加载，无法写入世界书",
    TOAST_SNAPSHOT: "已存入草稿箱",
    TOAST_TEST_OK: "API 连接成功！",
    TOAST_TEST_FAIL: (err) => `连接失败: ${err}`
};

let historyCache = [];
let templateCache = "";
let promptsCache = { initial: defaultSystemPromptInitial, refine: defaultSystemPromptRefine };
let availableWorldBooks = []; 
let isEditingTemplate = false; 
let observerInterval = null; 

// ============================================================================
// 1. 核心数据解析逻辑 (YAML 块级解析)
// ============================================================================

/**
 * 解析 YAML 文本为 Top-Level Blocks
 * 识别规则：行首无空格且包含冒号的行视为顶级键。
 * 该键及其下方所有缩进内容视为一个 Block。
 */
function parseYamlBlocks(text) {
    const blocks = new Map();
    if (!text) return blocks;
    
    const lines = text.split('\n');
    let currentKey = null;
    let buffer = [];

    lines.forEach(line => {
        // 匹配顶级键：开头无空格，包含英文或中文冒号
        const topKeyMatch = line.match(/^([^:\s：]+.*?)[:：]/);
        
        // 如果是顶级键 (且不是列表项 - )
        if (topKeyMatch && !line.trim().startsWith('-')) {
            // 如果之前有块，先保存
            if (currentKey) {
                blocks.set(currentKey, buffer.join('\n'));
            }
            // 开启新块
            currentKey = topKeyMatch[1].trim(); 
            buffer = [line]; 
        } else {
            // 属于当前块的内容
            if (currentKey) {
                buffer.push(line);
            }
        }
    });
    // 保存最后一个块
    if (currentKey) {
        blocks.set(currentKey, buffer.join('\n'));
    }
    return blocks;
}

function getTemplateKeys(templateText) {
    const keys = [];
    const lines = templateText.split('\n');
    lines.forEach(line => {
        const topKeyMatch = line.match(/^([^:\s：]+.*?)[:：]/);
        if (topKeyMatch && !line.trim().startsWith('-')) {
            keys.push(topKeyMatch[1].trim());
        }
    });
    return keys;
}

// 提取某个 Key 对应的完整 Block 文本
function getBlockContent(templateText, keyName) {
    const blocks = parseYamlBlocks(templateText);
    return blocks.get(keyName) || "";
}

async function collectActiveWorldInfoContent() {
    let content = [];
    try {
        const boundBooks = await getContextWorldBooks();
        const manualBooks = window.pwExtraBooks || [];
        const allBooks = [...new Set([...boundBooks, ...manualBooks])];
        for (const bookName of allBooks) {
            const entries = await getWorldBookEntries(bookName);
            const enabledEntries = entries.filter(e => e.enabled);
            if (enabledEntries.length > 0) {
                content.push(`\n--- World Book: ${bookName} ---`);
                enabledEntries.forEach(e => content.push(`[Entry: ${e.displayName}]\n${e.content}`));
            }
        }
    } catch (e) { console.error("Error collecting WI content:", e); }
    return content;
}

// ============================================================================
// 2. 存储与系统函数
// ============================================================================

function loadData() {
    try { historyCache = JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY)) || []; } catch { historyCache = []; }
    try { 
        templateCache = localStorage.getItem(STORAGE_KEY_TEMPLATE);
        if (!templateCache) templateCache = defaultTemplate; 
    } catch { templateCache = defaultTemplate; }
    
    try { 
        const p = JSON.parse(localStorage.getItem(STORAGE_KEY_PROMPTS));
        promptsCache = { ...{ initial: defaultSystemPromptInitial, refine: defaultSystemPromptRefine }, ...p };
    } catch { promptsCache = { initial: defaultSystemPromptInitial, refine: defaultSystemPromptRefine }; }
}

function saveData() {
    localStorage.setItem(STORAGE_KEY_TEMPLATE, templateCache);
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(historyCache));
    localStorage.setItem(STORAGE_KEY_PROMPTS, JSON.stringify(promptsCache));
}

function saveHistory(item) {
    const limit = extension_settings[extensionName]?.historyLimit || 50;
    historyCache.unshift(item);
    if (historyCache.length > limit) historyCache = historyCache.slice(0, limit);
    saveData();
}

function saveState(data) { localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(data)); }
function loadState() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY_STATE)) || {}; } catch { return {}; } }

function injectStyles() {
    const styleId = 'persona-weaver-css-v22';
    if ($(`#${styleId}`).length) return;
}

async function forceSavePersona(name, description) {
    const context = getContext();
    if (!context.powerUserSettings.personas) context.powerUserSettings.personas = {};
    context.powerUserSettings.personas[name] = description;
    context.powerUserSettings.persona_selected = name;
    
    const $nameInput = $('#your_name');
    const $descInput = $('#persona_description');
    if ($nameInput.length) $nameInput.val(name).trigger('input').trigger('change');
    if ($descInput.length) $descInput.val(description).trigger('input').trigger('change');
    const $h5Name = $('h5#your_name');
    if ($h5Name.length) $h5Name.text(name);
    await saveSettingsDebounced();
    return true;
}

async function syncToWorldInfoViaHelper(userName, content) {
    if (!window.TavernHelper) { toastr.error(TEXT.TOAST_WI_ERROR); return; }
    let targetBook = null;
    try {
        const charBooks = window.TavernHelper.getCharWorldbookNames('current');
        if (charBooks && charBooks.primary) targetBook = charBooks.primary;
        else if (charBooks && charBooks.additional && charBooks.additional.length > 0) targetBook = charBooks.additional[0]; 
    } catch (e) {}
    if (!targetBook) {
        const boundBooks = await getContextWorldBooks();
        if (boundBooks.length > 0) targetBook = boundBooks[0];
    }
    if (!targetBook) { toastr.warning(TEXT.TOAST_WI_FAIL); return; }

    try {
        const entries = await window.TavernHelper.getLorebookEntries(targetBook);
        const entryComment = `User: ${userName}`;
        const existingEntry = entries.find(e => e.comment === entryComment);
        if (existingEntry) {
            if (existingEntry.content !== content) {
                await window.TavernHelper.setLorebookEntries(targetBook, [{ uid: existingEntry.uid, content: content, enabled: true }]);
            }
        } else {
            const newEntry = { comment: entryComment, keys: [userName, "User"], content: content, enabled: true, selective: true, constant: false, position: { type: 'before_character_definition' } };
            await window.TavernHelper.createLorebookEntries(targetBook, [newEntry]);
        }
        toastr.success(TEXT.TOAST_WI_SUCCESS(targetBook));
    } catch (e) { console.error("[PW] Helper Sync Error:", e); toastr.error("同步世界书错误"); }
}

async function loadAvailableWorldBooks() {
    availableWorldBooks = [];
    if (window.TavernHelper && typeof window.TavernHelper.getWorldbookNames === 'function') {
        try { availableWorldBooks = window.TavernHelper.getWorldbookNames(); } catch {}
    }
    if (availableWorldBooks.length === 0 && window.world_names && Array.isArray(window.world_names)) {
        availableWorldBooks = window.world_names;
    }
    if (availableWorldBooks.length === 0) {
        try {
            const r = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}) });
            if (r.ok) { const d = await r.json(); availableWorldBooks = d.world_names || d; }
        } catch (e) {}
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
        if (data.character_book?.name) books.add(data.character_book.name);
        if (data.extensions?.world) books.add(data.extensions.world);
        if (data.world) books.add(data.world);
        if (context.chatMetadata?.world_info) books.add(context.chatMetadata.world_info);
    }
    return Array.from(books).filter(Boolean);
}

async function getWorldBookEntries(bookName) {
    let entriesData = null;
    if (window.TavernHelper && typeof window.TavernHelper.getLorebookEntries === 'function') {
        try { const entries = await window.TavernHelper.getLorebookEntries(bookName); return entries.map(e => ({ uid: e.uid, displayName: e.comment || (Array.isArray(e.keys) ? e.keys.join(', ') : e.keys) || "无标题", content: e.content || "", enabled: e.enabled })); } catch(e) {}
    }
    if (window.SillyTavern && typeof window.SillyTavern.loadWorldInfo === 'function') {
        try { const data = await window.SillyTavern.loadWorldInfo(bookName); if (data) entriesData = data.entries; } catch (e) {}
    }
    if (!entriesData) {
        try {
            const r = await fetch('/api/worldinfo/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: bookName }) });
            if (r.ok) { const d = await r.json(); entriesData = d.entries; }
        } catch (e) {}
    }
    if (entriesData) {
        return Object.values(entriesData).map(e => ({ uid: e.uid, displayName: e.comment || (Array.isArray(e.key) ? e.key.join(', ') : e.key) || "无标题", content: e.content || "", enabled: !e.disable && e.enabled !== false }));
    }
    return [];
}

async function runGeneration(data, apiConfig) {
    const context = getContext();
    const charId = context.characterId;
    const charName = (charId !== undefined) ? context.characters[charId].name : "None";
    const currentName = $('.persona_name').first().text().trim() || $('h5#your_name').text().trim() || "User";

    let wiText = "";
    if (data.wiContext && data.wiContext.length > 0) {
        wiText = `\n[Context from World Info]:\n${data.wiContext.join('\n')}\n`;
    }

    let systemTemplate = data.mode === 'refine' ? promptsCache.refine : promptsCache.initial;
    
    let systemPrompt = systemTemplate
        .replace(/{{user}}/g, currentName)
        .replace(/{{char}}/g, charName)
        .replace(/{{wi}}/g, wiText)
        .replace(/{{template}}/g, templateCache) 
        .replace(/{{input}}/g, data.request)
        .replace(/{{current}}/g, data.currentText || "");

    let responseContent = "";
    if (apiConfig.apiSource === 'independent') {
        const res = await fetch(`${apiConfig.indepApiUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.indepApiKey}` },
            body: JSON.stringify({ model: apiConfig.indepApiModel, messages: [{ role: 'system', content: systemPrompt }], temperature: 0.7 })
        });
        const json = await res.json();
        responseContent = json.choices[0].message.content;
    } else {
        responseContent = await context.generateQuietPrompt(systemPrompt, false, false, "System");
    }
    return responseContent.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
}

// ============================================================================
// 3. UI 渲染 logic
// ============================================================================

async function openCreatorPopup() {
    const context = getContext();
    loadData();
    await loadAvailableWorldBooks();
    const savedState = loadState();
    const config = { ...defaultSettings, ...extension_settings[extensionName], ...savedState.localConfig };
    
    let currentName = $('.persona_name').first().text().trim();
    if (!currentName) currentName = $('h5#your_name').text().trim();
    if (!currentName) currentName = context.powerUserSettings?.persona_selected || "User";

    const wiChecked = savedState.wiSyncChecked !== undefined ? savedState.wiSyncChecked : false;

    const renderBookOptions = () => {
        if (availableWorldBooks.length > 0) return availableWorldBooks.map(b => `<option value="${b}">${b}</option>`).join('');
        return `<option disabled>未找到世界书</option>`;
    };

    const html = `
    <div class="pw-wrapper">
        <div class="pw-header">
            <div class="pw-top-bar"><div class="pw-title"><i class="fa-solid fa-wand-magic-sparkles" style="color:#e0af68;"></i> 设定编织者 Pro</div></div>
            <div class="pw-tabs">
                <div class="pw-tab active" data-tab="editor">编辑</div>
                <div class="pw-tab" data-tab="context">世界书</div>
                <div class="pw-tab" data-tab="api">API & Prompt</div>
                <div class="pw-tab" data-tab="history">草稿</div>
            </div>
        </div>

        <div id="pw-view-editor" class="pw-view active">
            <div class="pw-scroll-area">
                <div class="pw-info-display"><div class="pw-info-item"><i class="fa-solid fa-user"></i><span id="pw-display-name">${currentName}</span></div></div>

                <div>
                    <div class="pw-tags-header">
                        <span class="pw-tags-label">快速插入 (点击插入键值块)</span>
                        <div class="pw-tags-actions">
                            <span class="pw-insert-all-btn" id="pw-btn-insert-all" title="插入完整模版"><i class="fa-solid fa-file-invoice"></i> 全部</span>
                            <span class="pw-template-edit-btn" id="pw-toggle-edit-template">编辑模版</span>
                        </div>
                    </div>
                    
                    <!-- 模版编辑区 -->
                    <div id="pw-template-editor-block" class="pw-template-editor-area">
                        <!-- [需求2] 编辑模版辅助工具 -->
                        <div class="pw-template-tools">
                            <button class="pw-mini-btn" id="pw-tpl-add-key">[+ 一级键]</button>
                            <button class="pw-mini-btn" id="pw-tpl-add-sub">[+ 二级键]</button>
                        </div>
                        <textarea id="pw-template-text" class="pw-template-textarea">${templateCache}</textarea>
                        <div style="text-align:right; margin-top:4px;">
                            <button class="pw-mini-btn" id="pw-save-template" style="display:inline-flex;">保存模版</button>
                        </div>
                    </div>

                    <!-- 模版键列表 -->
                    <div class="pw-tags-container" id="pw-template-keys-list"></div>
                </div>

                <textarea id="pw-request" class="pw-textarea" placeholder="在此输入初始设定要求 (支持自然语言)..." style="min-height:200px;">${savedState.request || ''}</textarea>
                <button id="pw-btn-gen" class="pw-btn gen">生成设定</button>

                <div id="pw-result-area" style="display:none; margin-top:15px;">
                    <div class="pw-relative-container">
                        <textarea id="pw-result-text" class="pw-result-textarea" placeholder="生成的结果将显示在这里..."></textarea>
                    </div>
                    
                    <!-- [需求3] 润色按钮竖排 & 高度压缩 -->
                    <div class="pw-refine-toolbar">
                        <textarea id="pw-refine-input" class="pw-refine-input" placeholder="输入润色意见..."></textarea>
                        <div class="pw-refine-actions">
                            <div class="pw-tool-btn-vertical" id="pw-btn-refine" title="执行润色">润色</div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="pw-footer">
                <div class="pw-footer-group">
                    <div class="pw-compact-btn danger" id="pw-clear" title="清空"><i class="fa-solid fa-eraser"></i></div>
                    <div class="pw-compact-btn" id="pw-snapshot" title="存入草稿 (Drafts)"><i class="fa-solid fa-save"></i></div>
                </div>
                <div class="pw-footer-group" style="flex:1; justify-content:flex-end;">
                    <div class="pw-wi-sync-toggle ${wiChecked ? 'active' : ''}" id="pw-wi-sync-btn" title="同时存入/更新世界书 (仅限角色绑定的世界书)"><i class="fa-solid fa-book-medical"></i></div>
                    <div class="pw-footer-main-btn" id="pw-btn-apply"><i class="fa-solid fa-check"></i> 保存并覆盖</div>
                </div>
            </div>
        </div>

        <div id="pw-diff-overlay" class="pw-diff-container" style="display:none;">
            <div class="pw-diff-header">润色对比 (按块展示)</div>
            <div class="pw-diff-scroll" id="pw-diff-list"></div>
            <div class="pw-diff-actions">
                <button class="pw-btn danger" id="pw-diff-cancel">放弃修改</button>
                <button class="pw-btn save" id="pw-diff-confirm">应用已选修改</button>
            </div>
        </div>

        <div id="pw-float-quote-btn" class="pw-float-quote-btn"><i class="fa-solid fa-pen-to-square"></i> 修改此段</div>

        <div id="pw-view-context" class="pw-view"><div class="pw-scroll-area"><div class="pw-card-section"><div class="pw-wi-controls"><select id="pw-wi-select" class="pw-input pw-wi-select"><option value="">-- 添加参考/目标世界书 --</option>${renderBookOptions()}</select><button id="pw-wi-refresh" class="pw-btn primary pw-wi-refresh-btn"><i class="fa-solid fa-sync"></i></button><button id="pw-wi-add" class="pw-btn primary pw-wi-add-btn"><i class="fa-solid fa-plus"></i></button></div></div><div id="pw-wi-container"></div></div></div>
        
        <div id="pw-view-api" class="pw-view">
            <div class="pw-scroll-area">
                <div class="pw-card-section">
                    <div class="pw-row pw-row-wrap">
                        <label>API 来源</label>
                        <select id="pw-api-source" class="pw-input" style="flex:1;"><option value="main" ${config.apiSource === 'main'?'selected':''}>主 API</option><option value="independent" ${config.apiSource === 'independent'?'selected':''}>独立 API</option></select>
                    </div>
                    <div id="pw-indep-settings" style="display:${config.apiSource === 'independent' ? 'flex' : 'none'}; flex-direction:column; gap:10px; margin-top:10px;">
                        <div class="pw-row pw-row-wrap"><label style="min-width:60px;">URL</label><input type="text" id="pw-api-url" class="pw-input" value="${config.indepApiUrl}" style="flex:1;"></div>
                        <div class="pw-row pw-row-wrap"><label style="min-width:60px;">Key</label><input type="password" id="pw-api-key" class="pw-input" value="${config.indepApiKey}" style="flex:1;"></div>
                        <div class="pw-row pw-row-wrap">
                            <label style="min-width:60px;">Model</label>
                            
                            <!-- [需求4] 下拉框 + 手动输入切换 -->
                            <div class="pw-api-select-group">
                                <select id="pw-api-model-select" class="pw-api-select">
                                    ${config.indepApiModel ? `<option value="${config.indepApiModel}" selected>${config.indepApiModel}</option>` : ''}
                                    <option value="gpt-3.5-turbo">gpt-3.5-turbo</option>
                                    <option value="gpt-4">gpt-4</option>
                                </select>
                                <input type="text" id="pw-api-model-input" class="pw-input" value="${config.indepApiModel}" style="display:none; flex:1;">
                                <i class="fa-solid fa-pen-to-square" id="pw-toggle-model-input" title="切换手动输入" style="cursor:pointer; opacity:0.7; padding:5px;"></i>
                            </div>
                            
                            <button id="pw-api-fetch" class="pw-btn primary" title="获取模型列表" style="width:auto; padding:6px 10px;"><i class="fa-solid fa-cloud-download-alt"></i></button>
                            <button id="pw-api-test" class="pw-btn primary" title="测试连接" style="width:auto; padding:6px 10px;"><i class="fa-solid fa-plug"></i></button>
                        </div>
                    </div>
                </div>

                <div class="pw-card-section pw-prompt-editor-block">
                    <div style="display:flex; justify-content:space-between;"><span class="pw-prompt-label">初始生成指令</span><button class="pw-mini-btn" id="pw-reset-prompts" style="font-size:0.7em;">恢复默认</button></div>
                    <textarea id="pw-prompt-initial" class="pw-textarea" style="height:120px; font-size:0.85em;">${promptsCache.initial}</textarea>
                    
                    <span class="pw-prompt-label" style="margin-top:10px;">润色指令</span>
                    <textarea id="pw-prompt-refine" class="pw-textarea" style="height:120px; font-size:0.85em;">${promptsCache.refine}</textarea>
                </div>
            </div>
        </div>

        <div id="pw-view-history" class="pw-view"><div class="pw-scroll-area"><div class="pw-search-box"><i class="fa-solid fa-search pw-search-icon"></i><input type="text" id="pw-history-search" class="pw-input pw-search-input" placeholder="搜索..."><i class="fa-solid fa-times pw-search-clear" id="pw-history-search-clear" title="清空"></i></div><div id="pw-history-list" style="display:flex; flex-direction:column;"></div><button id="pw-history-clear-all" class="pw-btn danger">清空所有</button></div></div>
    </div>
    `;

    callPopup(html, 'text', '', { wide: true, large: true, okButton: "关闭" });
    bindEvents();
    renderTemplateKeys();
    renderWiBooks();
    
    if (savedState.resultText) {
        $('#pw-result-text').val(savedState.resultText);
        $('#pw-result-area').show();
        $('#pw-request').addClass('minimized');
    }
}

// ============================================================================
// 4. 事件绑定
// ============================================================================

function bindEvents() {
    $(document).off('.pw');

    $(document).on('click.pw', '.pw-tab', function() {
        $('.pw-tab').removeClass('active'); $(this).addClass('active');
        $('.pw-view').removeClass('active');
        $(`#pw-view-${$(this).data('tab')}`).addClass('active');
        if($(this).data('tab') === 'history') renderHistoryList(); 
    });

    $(document).on('click.pw', '#pw-toggle-edit-template', function() {
        $('#pw-template-editor-block').slideToggle();
        $(this).text($('#pw-template-editor-block').is(':visible') ? '取消' : '编辑模版');
    });

    // 模版辅助工具：插入键
    $(document).on('click.pw', '#pw-tpl-add-key', function() {
        const el = document.getElementById('pw-template-text');
        const text = "\nNewKey:";
        const start = el.selectionStart;
        el.value = el.value.slice(0, start) + text + el.value.slice(el.selectionEnd);
        el.focus();
        el.selectionStart = el.selectionEnd = start + text.length;
    });
    $(document).on('click.pw', '#pw-tpl-add-sub', function() {
        const el = document.getElementById('pw-template-text');
        const text = "\n  SubKey:";
        const start = el.selectionStart;
        el.value = el.value.slice(0, start) + text + el.value.slice(el.selectionEnd);
        el.focus();
        el.selectionStart = el.selectionEnd = start + text.length;
    });

    $(document).on('click.pw', '#pw-save-template', function() {
        templateCache = $('#pw-template-text').val();
        saveData();
        renderTemplateKeys();
        $('#pw-template-editor-block').slideUp();
        $('#pw-toggle-edit-template').text('编辑模版');
        toastr.success("模版已保存");
    });

    $(document).on('click.pw', '#pw-btn-insert-all', function() {
        const cur = $('#pw-request').val();
        const newVal = cur ? (cur + '\n\n' + templateCache) : templateCache;
        $('#pw-request').val(newVal).focus();
        toastr.success("完整模版已插入");
    });

    // 悬浮引用
    const checkSelection = () => {
        const el = document.getElementById('pw-result-text');
        if (!el) return;
        const hasSelection = el.selectionStart !== el.selectionEnd;
        if (hasSelection) $('#pw-float-quote-btn').fadeIn(200).css('display', 'flex');
        else $('#pw-float-quote-btn').fadeOut(200);
    };
    $(document).on('touchend mouseup keyup', '#pw-result-text', checkSelection);

    $(document).on('click.pw', '#pw-float-quote-btn', function(e) {
        e.preventDefault(); e.stopPropagation();
        const textarea = document.getElementById('pw-result-text');
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selectedText = textarea.value.substring(start, end).trim();
        if (selectedText) {
            const $input = $('#pw-refine-input');
            const cur = $input.val();
            const newText = `将 "${selectedText}" 修改为: `;
            $input.val(cur ? cur + '\n' + newText : newText).focus();
            textarea.setSelectionRange(end, end);
            checkSelection();
        }
    });

    let saveTimeout;
    const saveCurrentState = () => {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
            // API Model 保存逻辑：优先取 Select，如果是 Manual 模式取 Input
            let apiModel = $('#pw-api-model-select').is(':visible') 
                ? $('#pw-api-model-select').val() 
                : $('#pw-api-model-input').val();

            saveState({
                request: $('#pw-request').val(),
                resultText: $('#pw-result-text').val(),
                hasResult: $('#pw-result-area').is(':visible'),
                wiSyncChecked: $('#pw-wi-sync-btn').hasClass('active'),
                localConfig: {
                    apiSource: $('#pw-api-source').val(),
                    indepApiUrl: $('#pw-api-url').val(),
                    indepApiKey: $('#pw-api-key').val(),
                    indepApiModel: apiModel,
                    extraBooks: window.pwExtraBooks || []
                }
            });
            promptsCache.initial = $('#pw-prompt-initial').val();
            promptsCache.refine = $('#pw-prompt-refine').val();
            saveData();
        }, 500); 
    };
    $(document).on('input.pw change.pw', '#pw-request, #pw-result-text, #pw-wi-toggle, .pw-input, #pw-prompt-initial, #pw-prompt-refine, #pw-api-model-select, #pw-api-model-input', saveCurrentState);

    // 润色 (Diff)
    $(document).on('click.pw', '#pw-btn-refine', async function() {
        const refineReq = $('#pw-refine-input').val();
        if (!refineReq) return toastr.warning("请输入润色意见");
        const oldText = $('#pw-result-text').val();
        const $btn = $(this).html('<i class="fas fa-spinner fa-spin"></i>');

        try {
            const wiContent = await collectActiveWorldInfoContent();
            
            // 获取当前 API Model
            let apiModel = $('#pw-api-model-select').is(':visible') 
                ? $('#pw-api-model-select').val() 
                : $('#pw-api-model-input').val();

            const config = { mode: 'refine', request: refineReq, currentText: oldText, wiContext: wiContent, apiSource: $('#pw-api-source').val(), indepApiUrl: $('#pw-api-url').val(), indepApiKey: $('#pw-api-key').val(), indepApiModel: apiModel };
            const responseText = await runGeneration(config, config);
            
            const oldBlocks = parseYamlBlocks(oldText);
            const newBlocks = parseYamlBlocks(responseText);
            const allKeys = [...new Set([...oldBlocks.keys(), ...newBlocks.keys()])];
            
            const $list = $('#pw-diff-list').empty();
            let changeCount = 0;

            allKeys.forEach(key => {
                const valOld = oldBlocks.get(key) || "";
                const valNew = newBlocks.get(key) || "";
                
                const isChanged = valOld.trim() !== valNew.trim();
                if (isChanged) changeCount++;
                if (!valOld && !valNew) return;

                let optionsHtml = '';
                if (!isChanged) {
                    optionsHtml = `<div class="pw-diff-options"><div class="pw-diff-opt single-view selected" data-val="${valNew}"><span class="pw-diff-opt-label">无变更</span><div class="pw-diff-opt-text">${valNew}</div></div></div>`;
                } else {
                    optionsHtml = `
                        <div class="pw-diff-options">
                            <div class="pw-diff-opt old diff-active" data-val="${valOld}"><span class="pw-diff-opt-label">原版本</span><div class="pw-diff-opt-text">${valOld || "(无)"}</div></div>
                            <div class="pw-diff-opt new selected diff-active" data-val="${valNew}"><span class="pw-diff-opt-label">新版本</span><div class="pw-diff-opt-text">${valNew || "(删除)"}</div></div>
                        </div>`;
                }
                const $row = $(`<div class="pw-diff-row" data-key="${key}"><div class="pw-diff-attr-name">${key}</div>${optionsHtml}<div class="pw-diff-edit-area"><textarea class="pw-diff-custom-input" placeholder="可微调...">${valNew}</textarea></div></div>`);
                $list.append($row);
            });

            if (changeCount === 0) toastr.info("AI 认为无需修改");
            $('#pw-diff-overlay').fadeIn();
            $('#pw-refine-input').val('');
        } catch (e) { toastr.error(e.message); }
        finally { $btn.html('润色'); }
    });

    $(document).on('click.pw', '.pw-diff-opt:not(.single-view)', function() {
        $(this).siblings().removeClass('selected'); $(this).addClass('selected');
        const val = $(this).data('val'); $(this).closest('.pw-diff-row').find('.pw-diff-custom-input').val(val);
    });

    $(document).on('click.pw', '#pw-diff-confirm', function() {
        let finalLines = [];
        $('.pw-diff-row').each(function() {
            const val = $(this).find('.pw-diff-custom-input').val().trim();
            if (!val) return;
            finalLines.push(val);
            finalLines.push(""); 
        });
        $('#pw-result-text').val(finalLines.join('\n').trim());
        $('#pw-diff-overlay').fadeOut();
        saveCurrentState(); 
        toastr.success("修改已应用");
    });

    $(document).on('click.pw', '#pw-diff-cancel', () => $('#pw-diff-overlay').fadeOut());

    $(document).on('click.pw', '#pw-btn-gen', async function() {
        const req = $('#pw-request').val();
        if (!req) return toastr.warning("请输入要求");
        const $btn = $(this).prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i>');
        try {
            const wiContent = await collectActiveWorldInfoContent();
            
            let apiModel = $('#pw-api-model-select').is(':visible') 
                ? $('#pw-api-model-select').val() 
                : $('#pw-api-model-input').val();

            const config = { mode: 'initial', request: req, wiContext: wiContent, apiSource: $('#pw-api-source').val(), indepApiUrl: $('#pw-api-url').val(), indepApiKey: $('#pw-api-key').val(), indepApiModel: apiModel };
            const text = await runGeneration(config, config);
            $('#pw-result-text').val(text);
            $('#pw-result-area').fadeIn();
            $('#pw-request').addClass('minimized');
            saveCurrentState();
        } catch (e) { toastr.error(e.message); } 
        finally { $btn.prop('disabled', false).html('生成设定'); }
    });

    // API Buttons [需求4]
    $(document).on('click.pw', '#pw-toggle-model-input', function() {
        const isSelect = $('#pw-api-model-select').is(':visible');
        if (isSelect) {
            // 切换到手动输入，复制当前选择的值
            $('#pw-api-model-input').val($('#pw-api-model-select').val()).show();
            $('#pw-api-model-select').hide();
            $(this).removeClass('fa-pen-to-square').addClass('fa-list');
        } else {
            // 切换回下拉框
            $('#pw-api-model-select').show();
            $('#pw-api-model-input').hide();
            $(this).removeClass('fa-list').addClass('fa-pen-to-square');
        }
    });

    $(document).on('click.pw', '#pw-api-fetch', async function() {
        const url = $('#pw-api-url').val();
        const key = $('#pw-api-key').val();
        if(!url) return toastr.warning("请先填写 URL");
        
        const $btn = $(this); $btn.find('i').addClass('fa-spin');
        try {
            const endpoint = url.includes('/v1') ? `${url.replace(/\/$/, '')}/models` : `${url.replace(/\/$/, '')}/v1/models`;
            const res = await fetch(endpoint, { method: 'GET', headers: { 'Authorization': `Bearer ${key}` } });
            if (!res.ok) throw new Error("Fetch failed");
            const data = await res.json();
            const models = (data.data || data).map(m => m.id).sort();
            
            const $sel = $('#pw-api-model-select').empty();
            models.forEach(m => $sel.append(`<option value="${m}">${m}</option>`));
            
            // 确保切换回下拉模式
            if ($('#pw-api-model-input').is(':visible')) {
                $('#pw-toggle-model-input').click();
            }
            toastr.success(`获取到 ${models.length} 个模型`);
        } catch(e) { toastr.error("获取模型失败: " + e.message); }
        finally { $btn.find('i').removeClass('fa-spin'); }
    });

    $(document).on('click.pw', '#pw-api-test', async function() {
        const url = $('#pw-api-url').val();
        const key = $('#pw-api-key').val();
        let model = $('#pw-api-model-select').is(':visible') ? $('#pw-api-model-select').val() : $('#pw-api-model-input').val();
        
        if(!url || !model) return toastr.warning("请填写完整信息");
        
        const $btn = $(this); $btn.find('i').addClass('fa-spin');
        try {
            const res = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                body: JSON.stringify({ model: model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 })
            });
            if(res.ok) toastr.success(TEXT.TOAST_TEST_OK);
            else throw new Error(res.statusText);
        } catch(e) { toastr.error(TEXT.TOAST_TEST_FAIL(e.message)); }
        finally { $btn.find('i').removeClass('fa-spin'); }
    });

    $(document).on('click.pw', '#pw-wi-sync-btn', function() { $(this).toggleClass('active'); saveCurrentState(); });

    $(document).on('click.pw', '#pw-btn-apply', async function() {
        const content = $('#pw-result-text').val();
        if (!content) return toastr.warning("内容为空");
        const name = $('.persona_name').first().text().trim() || $('h5#your_name').text().trim() || "User";
        await forceSavePersona(name, content);
        toastr.success(TEXT.TOAST_SAVE_SUCCESS(name));
        if ($('#pw-wi-sync-btn').hasClass('active')) { await syncToWorldInfoViaHelper(name, content); }
        $('.popup_close').click();
    });

    $(document).on('click.pw', '#pw-clear', function() {
        if(confirm("确定清空？")) { $('#pw-request').val('').removeClass('minimized'); $('#pw-result-area').hide(); $('#pw-result-text').val(''); saveCurrentState(); }
    });
    
    $(document).on('click.pw', '#pw-snapshot', function() {
        const text = $('#pw-result-text').val();
        const req = $('#pw-request').val();
        if (!text && !req) return toastr.warning("无内容");
        const context = getContext();
        const userName = $('.persona_name').first().text().trim() || "User";
        const defaultTitle = `${userName} (${new Date().toLocaleDateString()})`;
        saveHistory({ request: req || "无", timestamp: new Date().toLocaleString(), title: defaultTitle, data: { name: userName, resultText: text || "" } });
        toastr.success(TEXT.TOAST_SNAPSHOT);
    });

    $(document).on('click.pw', '.pw-hist-action-btn.edit', function(e) {
        e.stopPropagation();
        const $header = $(this).closest('.pw-hist-header');
        const $display = $header.find('.pw-hist-title-display');
        const $input = $header.find('.pw-hist-title-input');
        $display.hide(); $input.show().focus();
        const saveEdit = () => {
            const newVal = $input.val();
            $display.text(newVal).show(); $input.hide();
            const index = $header.closest('.pw-history-item').find('.pw-hist-action-btn.del').data('index'); 
            if (historyCache[index]) { historyCache[index].title = newVal; saveData(); }
            $(document).off('click.pw-hist-blur');
        };
        $input.one('blur keyup', function(ev) { if(ev.type === 'keyup' && ev.key !== 'Enter') return; saveEdit(); });
    });

    $(document).on('click.pw', '#pw-reset-prompts', () => {
        if(confirm("恢复默认 Prompts？")) {
            $('#pw-prompt-initial').val(defaultSystemPromptInitial);
            $('#pw-prompt-refine').val(defaultSystemPromptRefine);
            toastr.info("已恢复");
        }
    });

    $(document).on('click.pw', '#pw-wi-refresh', async () => {
        const btn = $(this); btn.find('i').addClass('fa-spin');
        await loadAvailableWorldBooks();
        const options = availableWorldBooks.length > 0 ? availableWorldBooks.map(b => `<option value="${b}">${b}</option>`).join('') : `<option disabled>未找到世界书</option>`;
        $('#pw-wi-select').html(`<option value="">-- 添加参考/目标世界书 --</option>${options}`);
        btn.find('i').removeClass('fa-spin'); toastr.success("已刷新");
    });
    $(document).on('click.pw', '#pw-wi-add', () => { const val = $('#pw-wi-select').val(); if (val && !window.pwExtraBooks.includes(val)) { window.pwExtraBooks.push(val); renderWiBooks(); } });
    $(document).on('input.pw', '#pw-history-search', renderHistoryList);
    $(document).on('click.pw', '#pw-history-search-clear', function() { $('#pw-history-search').val('').trigger('input'); });
    $(document).on('click.pw', '#pw-history-clear-all', function() { if(confirm("清空?")){historyCache=[];saveData();renderHistoryList();} });
}

// ... 渲染函数 ...
const renderTemplateKeys = () => {
    const $container = $('#pw-template-keys-list').empty();
    const keys = getTemplateKeys(templateCache);
    
    keys.forEach(key => {
        const $chip = $(`<div class="pw-tag-chip"><i class="fa-solid fa-cube" style="opacity:0.5; margin-right:4px;"></i><span>${key}</span></div>`);
        $chip.on('click', () => {
            const blockContent = getBlockContent(templateCache, key);
            const $text = $('#pw-request');
            const cur = $text.val();
            const prefix = (cur && !cur.endsWith('\n')) ? '\n\n' : ''; 
            $text.val(cur + prefix + blockContent).focus();
        });
        $container.append($chip);
    });
};

const renderHistoryList = () => {
    loadData();
    const $list = $('#pw-history-list').empty();
    const search = $('#pw-history-search').val().toLowerCase();
    const filtered = historyCache.filter(item => {
        if (!search) return true;
        return (item.title || "").toLowerCase().includes(search);
    });
    if (filtered.length === 0) { $list.html('<div style="text-align:center; opacity:0.6; padding:20px;">暂无草稿</div>'); return; }
    
    filtered.forEach((item, index) => {
        const displayTitle = item.title || "未命名";
        const $el = $(`
            <div class="pw-history-item">
                <div class="pw-hist-main">
                    <div class="pw-hist-header">
                        <span class="pw-hist-title-display">${displayTitle}</span>
                        <input type="text" class="pw-hist-title-input" value="${displayTitle}" style="display:none;">
                        <div style="display:flex; gap:5px;">
                            <i class="fa-solid fa-pen pw-hist-action-btn edit" title="编辑"></i>
                            <i class="fa-solid fa-trash pw-hist-action-btn del" data-index="${index}" title="删除"></i>
                        </div>
                    </div>
                    <div class="pw-hist-meta"><span>${item.timestamp || ''}</span></div>
                    <div class="pw-hist-desc">${(item.data.resultText || "").substring(0, 50)}...</div>
                </div>
            </div>
        `);
        $el.on('click', function(e) {
            if ($(e.target).closest('.pw-hist-action-btn, .pw-hist-title-input').length) return;
            $('#pw-request').val(item.request); $('#pw-result-text').val(item.data.resultText); $('#pw-result-area').show(); 
            $('#pw-request').addClass('minimized'); 
            $('.pw-tab[data-tab="editor"]').click();
        });
        $el.find('.pw-hist-action-btn.del').on('click', function(e) { 
            e.stopPropagation(); 
            if(confirm("删除?")) { historyCache.splice(historyCache.indexOf(item), 1); saveData(); renderHistoryList(); } 
        });
        $list.append($el);
    });
};

window.pwExtraBooks = [];
const renderWiBooks = async () => { const container = $('#pw-wi-container').empty(); const baseBooks = await getContextWorldBooks(); const allBooks = [...new Set([...baseBooks, ...(window.pwExtraBooks || [])])]; if (allBooks.length === 0) { container.html('<div style="opacity:0.6; padding:10px; text-align:center;">此角色未绑定世界书，请在“世界书”标签页手动添加或在酒馆主界面绑定。</div>'); return; } for (const book of allBooks) { const isBound = baseBooks.includes(book); const $el = $(`<div class="pw-wi-book"><div class="pw-wi-header"><span><i class="fa-solid fa-book"></i> ${book} ${isBound ? '<span style="color:#9ece6a;font-size:0.8em;margin-left:5px;">(已绑定)</span>' : ''}</span><div>${!isBound ? '<i class="fa-solid fa-times remove-book" style="color:#ff6b6b;margin-right:10px;" title="移除"></i>' : ''}<i class="fa-solid fa-chevron-down arrow"></i></div></div><div class="pw-wi-list" data-book="${book}"></div></div>`); $el.find('.remove-book').on('click', (e) => { e.stopPropagation(); window.pwExtraBooks = window.pwExtraBooks.filter(b => b !== book); renderWiBooks(); }); $el.find('.pw-wi-header').on('click', async function() { const $list = $el.find('.pw-wi-list'); const $arrow = $(this).find('.arrow'); if ($list.is(':visible')) { $list.slideUp(); $arrow.removeClass('fa-flip-vertical'); } else { $list.slideDown(); $arrow.addClass('fa-flip-vertical'); if (!$list.data('loaded')) { $list.html('<div style="padding:10px;text-align:center;"><i class="fas fa-spinner fa-spin"></i></div>'); const entries = await getWorldBookEntries(book); $list.empty(); if (entries.length === 0) $list.html('<div style="padding:10px;opacity:0.5;">无条目</div>'); entries.forEach(entry => { const isChecked = entry.enabled ? 'checked' : ''; const $item = $(`<div class="pw-wi-item"><div class="pw-wi-item-row"><input type="checkbox" class="pw-wi-check" ${isChecked} data-content="${encodeURIComponent(entry.content)}"><div style="font-weight:bold; font-size:0.9em; flex:1;">${entry.displayName}</div><i class="fa-solid fa-eye pw-wi-toggle-icon"></i></div><div class="pw-wi-desc">${entry.content}<div class="pw-wi-close-bar"><i class="fa-solid fa-angle-up"></i> 收起</div></div></div>`); $item.find('.pw-wi-toggle-icon').on('click', function(e) { e.stopPropagation(); const $desc = $(this).closest('.pw-wi-item').find('.pw-wi-desc'); if($desc.is(':visible')) { $desc.slideUp(); $(this).css('color', ''); } else { $desc.slideDown(); $(this).css('color', '#5b8db8'); } }); $item.find('.pw-wi-close-bar').on('click', function() { $(this).parent().slideUp(); $item.find('.pw-wi-toggle-icon').css('color', ''); }); $list.append($item); }); $list.data('loaded', true); } } }); container.append($el); } };

function addPersonaButton() {
    const container = $('.persona_controls_buttons_block');
    if (container.length === 0 || $(`#${BUTTON_ID}`).length > 0) return;
    const newButton = $(`<div id="${BUTTON_ID}" class="menu_button fa-solid fa-wand-magic-sparkles interactable" title="${TEXT.BTN_TITLE}" tabindex="0" role="button"></div>`);
    newButton.on('click', openCreatorPopup);
    container.prepend(newButton);
}

// [需求1] 使用 Interval 防止卡死 (替代 Observer)
function initPolling() {
    if (observerInterval) clearInterval(observerInterval);
    observerInterval = setInterval(() => {
        if ($(`#${BUTTON_ID}`).length === 0 && $('.persona_controls_buttons_block').length > 0) {
            addPersonaButton();
        }
    }, 2000); 
}

jQuery(async () => {
    injectStyles();
    addPersonaButton();
    initPolling();
});
