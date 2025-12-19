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
    outputFormat: 'yaml', 
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
    TOAST_WI_FAIL: "写入世界书失败，请检查是否已绑定世界书"
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
    const styleId = 'persona-weaver-css-v18';
    if ($(`#${styleId}`).length) return;
}

// [核心] 暴力写入 Persona
async function forceSavePersona(name, description, title) {
    const context = getContext();
    if (!context.powerUserSettings.personas) context.powerUserSettings.personas = {};
    context.powerUserSettings.personas[name] = description;

    if (!context.powerUserSettings.persona_titles) context.powerUserSettings.persona_titles = {};
    context.powerUserSettings.persona_titles[name] = title || "";

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

async function executeSlash(command) {
    const { executeSlashCommandsWithOptions } = SillyTavern;
    if (executeSlashCommandsWithOptions) {
        await executeSlashCommandsWithOptions(command, { quiet: true });
    } else {
        console.warn("[PW] Slash command API not found!");
    }
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

// [修复] 更健壮的世界书查找逻辑
async function getContextWorldBooks(extras = []) {
    const context = getContext();
    const books = new Set(extras); 

    const charId = context.characterId;
    if (charId !== undefined && context.characters[charId]) {
        const char = context.characters[charId];
        const data = char.data || char;
        
        // 尝试多种路径获取绑定
        const v2Book = data.character_book?.name; // V2 卡格式
        const extWorld = data.extensions?.world;  // 扩展字段
        const legacyWorld = data.world;           // 旧格式
        
        // 还要检查 chat_metadata (如果是群聊或特定聊天绑定)
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
    } catch (e) {
        console.error(e);
        return [];
    }
}

async function runGeneration(data, apiConfig) {
    const context = getContext();
    const char = context.characters[context.characterId];
    
    const formatInst = data.format === 'yaml' 
        ? `"description": "Use YAML format key-value pairs."`
        : `"description": "Narrative paragraph style."`;

    let wiText = "";
    if (data.wiContext && data.wiContext.length > 0) {
        wiText = `\n[Context]:\n${data.wiContext.join('\n\n')}\n`;
    }

    // 获取只读显示的当前名字
    const currentName = $('#pw-display-name').text().trim() || "User";
    const currentTitle = $('#pw-display-title').text().trim() || "";

    const systemPrompt = `You are a creative writing assistant.
Task: Create a User Persona Description based on Request.
${wiText}
Target Character: ${char.name}
Scenario: ${char.scenario || "None"}

[User Request]:
${data.request}

[Instructions]:
1. Character Name: "${currentName}" (Do not change this).
2. Character Title: "${currentTitle}" (Do not change this).

[Response Format]:
Return ONLY a JSON object:
{
    "description": ${formatInst},
    "wi_entry": "Concise facts about ${currentName}."
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
        return JSON.parse(content.match(/\{[\s\S]*\}/)[0]);
    } else {
        const generatedText = await context.generateQuietPrompt(systemPrompt, false, false, "System");
        return JSON.parse(generatedText.match(/\{[\s\S]*\}/)[0]);
    }
}

// ============================================================================
// 3. UI 渲染
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
    
    // 获取当前信息
    const currentDomName = $('#your_name').val() || "User";
    const currentDomDesc = $('#persona_description').val() || "";
    const currentDomTitle = context.powerUserSettings?.persona_titles?.[currentDomName] || "";

    const initDesc = savedState.desc || currentDomDesc;

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
                
                <!-- 名字/Title 显示区域 (只读) -->
                <div class="pw-info-display">
                    <div class="pw-info-item">
                        <i class="fa-solid fa-user"></i>
                        <span id="pw-display-name">${currentDomName}</span>
                    </div>
                    <div class="pw-info-item">
                        <i class="fa-solid fa-tag"></i>
                        <span id="pw-display-title" style="opacity:0.8; font-size:0.9em;">${currentDomTitle || "无头衔"}</span>
                    </div>
                </div>

                <div>
                    <div class="pw-tags-header">
                        <span class="pw-tags-label">快速标签</span>
                        <span class="pw-tags-edit-toggle" id="pw-toggle-edit-tags">编辑标签</span>
                    </div>
                    <div class="pw-tags-container" id="pw-tags-list"></div>
                </div>

                <div style="flex:1; display:flex; flex-direction:column; gap:8px;">
                    <textarea id="pw-request" class="pw-textarea" placeholder="在此输入设定要求，或点击上方标签..." style="min-height:100px;">${savedState.request || ''}</textarea>
                    
                    <div class="pw-editor-tools">
                        <div class="pw-mini-btn" id="pw-clear"><i class="fa-solid fa-eraser"></i> 清空</div>
                        <div class="pw-mini-btn" id="pw-snapshot"><i class="fa-solid fa-save"></i> 存入历史</div>
                        <select id="pw-fmt-select" class="pw-input" style="width:auto; padding:2px 8px; font-size:0.85em;">
                            <option value="yaml" ${config.outputFormat === 'yaml' ? 'selected' : ''}>YAML 属性</option>
                            <option value="paragraph" ${config.outputFormat === 'paragraph' ? 'selected' : ''}>小说段落</option>
                        </select>
                    </div>
                </div>

                <button id="pw-btn-gen" class="pw-btn gen"><i class="fa-solid fa-bolt"></i> 生成 / 润色</button>

                <div id="pw-result-area" style="display: ${savedState.hasResult ? 'block' : 'none'}; border-top: 1px dashed var(--SmartThemeBorderColor); padding-top: 15px; margin-top:5px;">
                    <div style="font-weight:bold; margin-bottom:10px; color:#5b8db8;"><i class="fa-solid fa-check-circle"></i> 生成结果</div>
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        <textarea id="pw-res-desc" class="pw-textarea" rows="6" placeholder="用户设定描述">${initDesc}</textarea>
                        
                        <div style="background:rgba(0,0,0,0.1); padding:10px; border-radius:8px; border:1px solid var(--SmartThemeBorderColor);">
                            <div style="display:flex; align-items:center; gap:5px; margin-bottom:5px;">
                                <input type="checkbox" id="pw-wi-toggle" checked>
                                <span style="font-size:0.9em; font-weight:bold;">同步写入世界书</span>
                            </div>
                            <textarea id="pw-res-wi" class="pw-textarea" rows="3" placeholder="世界书条目内容...">${savedState.wiContent || ''}</textarea>
                        </div>
                    </div>
                    <button id="pw-btn-apply" class="pw-btn save"><i class="fa-solid fa-check"></i> 保存设定</button>
                </div>
            </div>
        </div>

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
                <!-- API 视图内容保持不变 -->
                <div class="pw-card-section">
                    <div class="pw-row">
                        <label>API 来源</label>
                        <select id="pw-api-source" class="pw-input" style="flex:1;">
                            <option value="main" ${config.apiSource === 'main' ? 'selected' : ''}>使用主 API</option>
                            <option value="independent" ${config.apiSource === 'independent' ? 'selected' : ''}>独立 API</option>
                        </select>
                    </div>
                    <div id="pw-indep-settings" style="display:${config.apiSource === 'independent' ? 'flex' : 'none'}; flex-direction:column; gap:15px;">
                        <div class="pw-row">
                            <label>URL</label>
                            <input type="text" id="pw-api-url" class="pw-input" value="${config.indepApiUrl}" placeholder="https://api.openai.com/v1" style="flex:1;">
                        </div>
                        <div class="pw-row">
                            <label>Key</label>
                            <input type="password" id="pw-api-key" class="pw-input" value="${config.indepApiKey}" style="flex:1;">
                        </div>
                        <div class="pw-row pw-api-model-row">
                            <label>Model</label>
                            <div style="flex:1; display:flex; gap:5px; width:100%;">
                                <input type="text" id="pw-api-model" class="pw-input" value="${config.indepApiModel}" list="pw-model-list" style="flex:1;">
                                <datalist id="pw-model-list"></datalist>
                                <button id="pw-api-fetch" class="pw-btn primary pw-api-fetch-btn" title="获取模型" style="width:auto;"><i class="fa-solid fa-cloud-download-alt"></i></button>
                            </div>
                        </div>
                    </div>
                    <div style="text-align:right;">
                        <button id="pw-api-save" class="pw-btn primary" style="width:auto;"><i class="fa-solid fa-save"></i> 保存设置</button>
                    </div>
                </div>
            </div>
        </div>

        <div id="pw-view-history" class="pw-view">
            <div class="pw-scroll-area">
                <div class="pw-search-box">
                    <input type="text" id="pw-history-search" class="pw-input pw-search-input" placeholder="🔍 搜索历史...">
                    <i class="fa-solid fa-times pw-search-clear" id="pw-history-search-clear" title="清空搜索"></i>
                </div>
                <div id="pw-history-list" style="display:flex; flex-direction:column;"></div>
                <button id="pw-history-clear-all" class="pw-btn danger"><i class="fa-solid fa-trash-alt"></i> 清空所有历史记录</button>
            </div>
        </div>
    </div>
    `;

    callPopup(html, 'text', '', { wide: true, large: true, okButton: "关闭" });

    // 绑定事件（每次打开弹窗时重新绑定，因为弹窗是新创建的 DOM）
    bindEvents();
    
    // 初始化标签和WI列表
    renderTagsList();
    renderWiBooks();
}

// ============================================================================
// 4. 事件绑定与逻辑处理 (全改用 document 委托)
// ============================================================================

function bindEvents() {
    // 解绑旧事件防止重复
    $(document).off('.pw');

    // 状态保存
    const saveCurrentState = () => {
        saveState({
            request: $('#pw-request').val(),
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
    $(document).on('input.pw change.pw', '#pw-request, #pw-res-desc, #pw-res-wi, .pw-input', saveCurrentState);

    // Tab 切换
    $(document).on('click.pw', '.pw-tab', function() {
        $('.pw-tab').removeClass('active');
        $(this).addClass('active');
        $('.pw-view').removeClass('active');
        const tab = $(this).data('tab');
        $(`#pw-view-${tab}`).addClass('active');
        if(tab === 'history') renderHistoryList(); 
    });

    // 清空与快照 (修复：使用 document 委托)
    $(document).on('click.pw', '#pw-clear', function() {
        if(confirm("清空输入内容？")) {
            $('#pw-request').val('');
            $('#pw-result-area').hide();
            saveCurrentState();
        }
    });

    $(document).on('click.pw', '#pw-snapshot', function() {
        const req = $('#pw-request').val();
        const curName = $('#pw-display-name').text();
        const curDesc = $('#pw-res-desc').val();
        
        if (!req && !curDesc) return;
        
        saveHistory({ 
            request: req || "无请求内容", 
            timestamp: new Date().toLocaleString(),
            targetChar: getContext().characters[getContext().characterId]?.name || "未知",
            data: { 
                name: curName, 
                description: curDesc || "", 
                wi_entry: $('#pw-res-wi').val()
            } 
        });
        toastr.success(TEXT.TOAST_SNAPSHOT);
    });

    // 生成逻辑
    $(document).on('click.pw', '#pw-btn-gen', async function() {
        const req = $('#pw-request').val();
        const curDesc = $('#pw-res-desc').val();
        
        let fullReq = req;
        if (curDesc) fullReq += `\n\n[Current Description]:\n${curDesc}`;

        const $btn = $(this);
        const oldText = $btn.html();
        $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 处理中...');

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
            
            $('#pw-res-desc').val(data.description);
            $('#pw-res-wi').val(data.wi_entry || data.description);
            $('#pw-result-area').fadeIn();
            
            saveCurrentState();
        } catch (e) {
            console.error(e);
            toastr.error(`${TEXT.TOAST_GEN_FAIL}: ${e.message}`);
        } finally {
            $btn.prop('disabled', false).html(oldText);
        }
    });

    // 应用保存逻辑 (修复WI保存)
    $(document).on('click.pw', '#pw-btn-apply', async function() {
        const name = $('#pw-display-name').text();
        const title = $('#pw-display-title').text();
        const desc = $('#pw-res-desc').val();
        const wiContent = $('#pw-res-wi').val();
        
        // 1. 保存到 Persona
        try {
            await forceSavePersona(name, desc, title === "无头衔" ? "" : title);
            toastr.success(TEXT.TOAST_SAVE_SUCCESS(name));
        } catch (e) {
            toastr.error("保存失败: " + e.message);
            return;
        }

        // 2. 写入世界书
        if ($('#pw-wi-toggle').is(':checked') && wiContent) {
            const context = getContext();
            
            // 重新获取绑定的书
            const boundBooks = await getContextWorldBooks();
            let targetBook = null;

            if (boundBooks.length > 0) {
                targetBook = boundBooks[0]; // 默认取第一本绑定的书
            } else if (window.pwExtraBooks && window.pwExtraBooks.length > 0) {
                targetBook = window.pwExtraBooks[0]; // 如果没有绑定的，取用户手动在工具里添加的第一本
            }

            if (targetBook) {
                try {
                    const headers = getRequestHeaders();
                    const r = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name: targetBook }) });
                    if (r.ok) {
                        const d = await r.json();
                        if (!d.entries) d.entries = {};
                        const ids = Object.keys(d.entries).map(Number);
                        const newId = ids.length ? Math.max(...ids) + 1 : 0;
                        
                        const keys = [name, "User"];
                        if (title && title !== "无头衔") keys.push(title);

                        d.entries[newId] = { 
                            uid: newId, 
                            key: keys, 
                            content: wiContent, 
                            comment: `User: ${name}`, 
                            enabled: true, 
                            selective: true 
                        };
                        
                        await fetch('/api/worldinfo/edit', { method: 'POST', headers, body: JSON.stringify({ name: targetBook, data: d }) });
                        toastr.success(TEXT.TOAST_WI_SUCCESS(targetBook));
                        if (context.updateWorldInfoList) context.updateWorldInfoList();
                    }
                } catch(e) { console.error("WI Update Failed", e); }
            } else {
                toastr.warning(TEXT.TOAST_WI_FAIL);
            }
        }
        
        // 关闭弹窗
        $('.popup_close').click();
    });

    // 标签编辑开关
    $(document).on('click.pw', '#pw-toggle-edit-tags', () => {
        isEditingTags = !isEditingTags;
        renderTagsList();
    });
    
    // API 相关事件
    $(document).on('change.pw', '#pw-api-source', function() { $('#pw-indep-settings').toggle($(this).val() === 'independent'); });
    $(document).on('click.pw', '#pw-api-fetch', async function() {
        const btn = $(this);
        btn.html('<i class="fas fa-spinner fa-spin"></i>');
        const models = await fetchModels($('#pw-api-url').val(), $('#pw-api-key').val());
        btn.html('<i class="fa-solid fa-cloud-download-alt"></i>');
        if (models.length) {
            const list = $('#pw-model-list').empty();
            models.forEach(m => list.append(`<option value="${m}">`));
            toastr.success(TEXT.TOAST_API_OK);
        } else { toastr.error(TEXT.TOAST_API_ERR); }
    });
    $(document).on('click.pw', '#pw-api-save', () => { saveCurrentState(); toastr.success(TEXT.TOAST_SAVE_API); });

    // 历史记录相关
    $(document).on('input.pw', '#pw-history-search', renderHistoryList);
    $(document).on('click.pw', '#pw-history-search-clear', function() { $('#pw-history-search').val('').trigger('input'); });
    $(document).on('click.pw', '#pw-history-clear-all', function() {
        if (historyCache.length === 0) return;
        if(confirm("确定要清空所有历史记录吗？")) {
            historyCache = [];
            saveData();
            renderHistoryList();
        }
    });
    
    // 世界书添加
    $(document).on('click.pw', '#pw-wi-add', () => {
        const val = $('#pw-wi-select').val();
        if (val && !window.pwExtraBooks.includes(val)) {
            window.pwExtraBooks.push(val);
            renderWiBooks();
        }
    });
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
            const $row = $(`
                <div class="pw-tag-edit-row">
                    <input class="pw-tag-edit-input t-name" value="${tag.name}" placeholder="名">
                    <input class="pw-tag-edit-input t-val" value="${tag.value}" placeholder="值">
                    <div class="pw-tag-del-btn" title="删除"><i class="fa-solid fa-trash"></i></div>
                </div>
            `);
            
            $row.find('input').on('input', function() {
                tag.name = $row.find('.t-name').val();
                tag.value = $row.find('.t-val').val();
                saveData();
            });

            $row.find('.pw-tag-del-btn').on('click', () => {
                if (confirm(`删除标签 "${tag.name}"?`)) {
                    tagsCache.splice(index, 1);
                    saveData();
                    renderTagsList();
                }
            });
            $container.append($row);
        } else {
            const $chip = $(`
                <div class="pw-tag-chip" title="点击插入">
                    <i class="fa-solid fa-tag" style="opacity:0.5; margin-right:4px;"></i>
                    <span>${tag.name}</span>
                    ${tag.value ? `<span class="pw-tag-val">${tag.value}</span>` : ''}
                </div>
            `);
            
            $chip.on('click', () => {
                const $text = $('#pw-request');
                const cur = $text.val();
                const insert = tag.value ? `${tag.name}: ${tag.value}` : `${tag.name}: `;
                const prefix = (cur && !cur.endsWith('\n')) ? '\n' : '';
                $text.val(cur + prefix + insert).focus();
                $text[0].scrollTop = $text[0].scrollHeight;
            });
            $container.append($chip);
        }
    });

    const $addBtn = $(`<div class="pw-tag-add-btn"><i class="fa-solid fa-plus"></i> ${isEditingTags ? '新增' : '标签'}</div>`);
    $addBtn.on('click', () => {
        tagsCache.push({ name: "", value: "" });
        saveData();
        if (!isEditingTags) isEditingTags = true; 
        renderTagsList();
    });
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
        container.html('<div style="opacity:0.6; padding:10px; text-align:center;">此角色未绑定世界书，请先在世界书面板绑定，或在上方手动添加。</div>');
        return;
    }

    for (const book of allBooks) {
        const isBound = baseBooks.includes(book);
        const $el = $(`
            <div class="pw-wi-book">
                <div class="pw-wi-header">
                    <span><i class="fa-solid fa-book"></i> ${book} ${isBound ? '<span style="color:#9ece6a;font-size:0.8em;margin-left:5px;">(已绑定)</span>' : ''}</span>
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
                                <div class="pw-wi-desc">
                                    ${entry.content}
                                    <div class="pw-wi-close-bar"><i class="fa-solid fa-angle-up"></i> 收起</div>
                                </div>
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

                        $item.find('.pw-wi-close-bar').on('click', function() {
                            $(this).parent().slideUp();
                            $item.find('.pw-wi-toggle-icon').css('color', '');
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
        const content = (item.data.description || "").toLowerCase();
        return name.includes(search) || content.includes(search);
    });

    if (filtered.length === 0) {
        $list.html('<div style="text-align:center; opacity:0.6; padding:20px;">暂无历史记录</div>');
        return;
    }

    filtered.forEach((item, index) => {
        const displayTitle = item.data.name || "未命名";
        const targetChar = item.targetChar || "未知";

        const $el = $(`
            <div class="pw-history-item">
                <div class="pw-hist-main">
                    <div style="font-weight:bold; color:#e0af68;">${displayTitle}</div>
                    <div class="pw-hist-meta">
                        <span><i class="fa-solid fa-user-tag"></i> ${targetChar}</span>
                        <span><i class="fa-regular fa-clock"></i> ${item.timestamp || ''}</span>
                    </div>
                    <div class="pw-hist-desc">${item.data.description || item.request || '无描述'}</div>
                </div>
                <div class="pw-hist-del-btn"><i class="fa-solid fa-trash"></i></div>
            </div>
        `);

        $el.on('click', function(e) {
            if ($(e.target).closest('.pw-hist-del-btn').length) return;
            $('#pw-request').val(item.request);
            $('#pw-res-desc').val(item.data.description);
            $('#pw-res-wi').val(item.data.wi_entry);
            $('#pw-result-area').show();
            $('.pw-tab[data-tab="editor"]').click();
        });

        $el.find('.pw-hist-del-btn').on('click', function(e) {
            e.stopPropagation();
            if(confirm(`删除这条记录?`)) {
                historyCache.splice(historyCache.indexOf(item), 1);
                saveData();
                renderHistoryList();
            }
        });

        $list.append($el);
    });
};

// ============================================================================
// 初始化
// ============================================================================

function addPersonaButton() {
    const container = $('.persona_controls_buttons_block');
    if (container.length === 0 || $(`#${BUTTON_ID}`).length > 0) return;

    const newButton = $(`
        <div id="${BUTTON_ID}"
             class="menu_button fa-solid fa-wand-magic-sparkles interactable"
             title="${TEXT.BTN_TITLE}"
             tabindex="0"
             role="button">
        </div>
    `);

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
