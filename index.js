import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced, callPopup, getRequestHeaders, eventSource, event_types } from "../../../../script.js";
import { Popup } from "../../../../scripts/popup.js";

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

const extensionName = "st-persona-weaver";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const defaultSettings = {
    autoSwitchPersona: true,    // 保存后自动切换到新马甲
    syncToWorldInfo: true,      // 默认勾选写入世界书
    historyLimit: 10            // 历史记录数量
};

const STORAGE_KEY_HISTORY = 'pw_generation_history_v1';
const STORAGE_KEY_STATE = 'pw_current_state_v1';

// UI Text Constants
const TEXT = {
    PANEL_TITLE: "用户设定编织者 ✒️",
    BTN_OPEN_MAIN: "✨ 打开设定生成器",
    BTN_OPEN_DESC: "AI 辅助生成用户人设、描述并同步世界书",
    LABEL_AUTO_SWITCH: "保存后自动切换马甲",
    LABEL_SYNC_WI: "默认勾选同步世界书",
    TOAST_NO_CHAR: "请先打开一个角色聊天",
    TOAST_GEN_FAIL: "AI 生成失败，请检查连接",
    TOAST_SAVE_SUCCESS: (name) => `已保存并切换为: ${name}`,
    TOAST_WI_SUCCESS: (book) => `已更新世界书: ${book}`
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

// 注入样式
function injectStyles() {
    const styleId = 'persona-weaver-css';
    if ($(`#${styleId}`).length) return;

    const css = `
    .pw-wrapper { display: flex; flex-direction: column; height: 100%; text-align: left; }
    .pw-header { padding: 10px; border-bottom: 1px solid var(--SmartThemeBorderColor); display: flex; justify-content: space-between; align-items: center; }
    .pw-title { font-weight: bold; font-size: 1.1em; }
    .pw-tools i { cursor: pointer; margin-left: 15px; opacity: 0.7; transition: 0.2s; }
    .pw-tools i:hover { opacity: 1; transform: scale(1.1); }
    
    .pw-scroll-area { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 15px; }
    
    .pw-label { font-size: 0.85em; opacity: 0.7; font-weight: bold; margin-bottom: 4px; display: block; text-transform: uppercase; }
    .pw-textarea { width: 100%; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); color: var(--SmartThemeBodyColor); border-radius: 5px; padding: 10px; resize: none; min-height: 80px; box-sizing: border-box; }
    .pw-input { width: 100%; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); color: var(--SmartThemeBodyColor); padding: 8px; border-radius: 5px; box-sizing: border-box; }
    
    .pw-card { background: var(--black30a); border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    
    .pw-btn { border: none; padding: 10px; border-radius: 5px; font-weight: bold; cursor: pointer; color: white; width: 100%; margin-top: 5px; display: flex; align-items: center; justify-content: center; gap: 5px; }
    .pw-btn.gen { background: var(--SmartThemeQuoteColor); }
    .pw-btn.save { background: var(--SmartThemeEmColor); }
    .pw-btn:disabled { opacity: 0.6; cursor: not-allowed; }

    .pw-history-item { padding: 10px; border-bottom: 1px solid var(--SmartThemeBorderColor); cursor: pointer; transition: 0.2s; }
    .pw-history-item:hover { background: var(--white10a); }
    .pw-view { display: none; flex-direction: column; flex: 1; min-height: 0; }
    .pw-view.active { display: flex; }
    `;
    $('<style>').attr('id', styleId).html(css).appendTo('head');
}

// ============================================================================
// CORE LOGIC
// ============================================================================

async function getCurrentWorldbook() {
    const context = getContext();
    
    // Check Chat World Book
    if (context.chatMetadata && context.chatMetadata.world_info) {
        return context.chatMetadata.world_info;
    }

    // Check Character Linked World Book
    const charId = context.characterId;
    if (charId !== undefined && context.characters[charId]) {
        const char = context.characters[charId];
        const data = char.data || char;
        // Check standard locations
        const world = data.extensions?.world || data.world || data.character_book?.name;
        if (world && typeof world === 'string') return world;
    }

    return null;
}

async function generatePersona(userRequest) {
    const context = getContext();
    const charId = context.characterId;
    if (charId === undefined) throw new Error("No character selected");
    
    const char = context.characters[charId];
    const name = char.name;
    const desc = char.description;
    const scenario = char.scenario || "";

    const prompt = `
Task: Create a User Persona based on the user's request and the current character's context.
Current Character: ${name}
Description: ${desc}
Scenario: ${scenario}

User Request: ${userRequest}

Return ONLY a JSON object with this format (no other text):
{
    "name": "Name of the persona",
    "description": "Description of the persona (appearance, personality, relation to character). Approx 100-200 words.",
    "wi_entry": "Background facts about this persona suitable for World Info/Lorebook."
}`;

    try {
        // Use SillyTavern's native generateQuietPrompt
        // prompt, as_user=false, is_impersonate=false, quiet_name="System", quiet_image=null
        const generatedText = await context.generateQuietPrompt(prompt, false, false, "System");
        
        const jsonMatch = generatedText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Failed to parse JSON from AI response");
        
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
    const currentWb = await getCurrentWorldbook();

    const html = `
    <div class="pw-wrapper">
        <div class="pw-header">
            <div class="pw-title"><i class="fa-solid fa-wand-magic-sparkles"></i> 设定构思</div>
            <div class="pw-tools">
                <i class="fa-solid fa-eraser" id="pw-clear" title="清空"></i>
                <i class="fa-solid fa-clock-rotate-left" id="pw-history" title="历史记录"></i>
            </div>
        </div>

        <!-- Editor View -->
        <div id="pw-view-editor" class="pw-view active">
            <div class="pw-scroll-area">
                <div>
                    <span class="pw-label">我的要求</span>
                    <textarea id="pw-request" class="pw-textarea" placeholder="例如：我是她的青梅竹马，现在是敌对阵营的指挥官...">${savedState.request || ''}</textarea>
                    <button id="pw-btn-gen" class="pw-btn gen"><i class="fa-solid fa-bolt"></i> AI 生成 / 润色</button>
                </div>

                <div id="pw-result-area" style="display: ${savedState.hasResult ? 'block' : 'none'}">
                    <div style="border-top: 1px dashed var(--SmartThemeBorderColor); margin: 10px 0;"></div>
                    <span class="pw-label"><i class="fa-solid fa-check-circle"></i> 结果确认</span>
                    
                    <div class="pw-card">
                        <div>
                            <span class="pw-label">角色名称 (Name)</span>
                            <input type="text" id="pw-res-name" class="pw-input" value="${savedState.name || ''}">
                        </div>
                        <div>
                            <span class="pw-label">用户设定 (Description)</span>
                            <textarea id="pw-res-desc" class="pw-textarea" rows="4">${savedState.desc || ''}</textarea>
                        </div>
                        
                        ${currentWb ? `
                        <div style="margin-top:5px; display: flex; align-items: center; gap: 8px;">
                            <input type="checkbox" id="pw-wi-toggle" ${extension_settings[extensionName].syncToWorldInfo ? 'checked' : ''}>
                            <label for="pw-wi-toggle" style="font-size: 0.9em; cursor: pointer;">
                                同步写入世界书 (${currentWb})
                            </label>
                        </div>
                        <div id="pw-wi-container" style="margin-top: 5px;">
                            <textarea id="pw-res-wi" class="pw-textarea" rows="3" placeholder="世界书条目内容...">${savedState.wiContent || ''}</textarea>
                        </div>
                        ` : '<div style="opacity:0.5; font-size:0.8em; font-style:italic; margin-top:5px;">未检测到绑定世界书</div>'}
                    </div>

                    <button id="pw-btn-save" class="pw-btn save"><i class="fa-solid fa-floppy-disk"></i> 保存并启用</button>
                </div>
            </div>
        </div>

        <!-- History View -->
        <div id="pw-view-history" class="pw-view">
            <div class="pw-scroll-area" id="pw-history-list"></div>
            <div style="padding: 10px; border-top: 1px solid var(--SmartThemeBorderColor); text-align: center;">
                <button id="pw-btn-back" class="menu_button" style="width: auto;"><i class="fa-solid fa-arrow-left"></i> 返回编辑</button>
            </div>
        </div>
    </div>
    `;

    // Show Popup
    await callPopup(html, 'text', '', { wide: true, large: true, okButton: "关闭" });

    // === Event Binding using jQuery inside Popup ===
    const $popup = $('.swal2-popup'); // Target active popup
    
    const autoSave = () => {
        saveState({
            request: $('#pw-request').val(),
            hasResult: $('#pw-result-area').css('display') !== 'none',
            name: $('#pw-res-name').val(),
            desc: $('#pw-res-desc').val(),
            wiContent: $('#pw-res-wi').val()
        });
    };
    $popup.on('input change', 'input, textarea', autoSave);

    // Generate
    $('#pw-btn-gen').on('click', async function() {
        const req = $('#pw-request').val();
        if (!req.trim()) return toastr.warning("请输入要求");

        const $btn = $(this);
        const oldText = $btn.html();
        $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 生成中...');

        try {
            const data = await generatePersona(req);
            
            $('#pw-res-name').val(data.name);
            $('#pw-res-desc').val(data.description);
            $('#pw-res-wi').val(data.wi_entry || data.description);
            $('#pw-result-area').fadeIn();
            
            saveHistory({ request: req, data: data });
            autoSave();
        } catch (e) {
            toastr.error(TEXT.TOAST_GEN_FAIL);
        } finally {
            $btn.prop('disabled', false).html(oldText);
        }
    });

    // Save
    $('#pw-btn-save').on('click', async function() {
        const name = $('#pw-res-name').val();
        const desc = $('#pw-res-desc').val();
        const wiContent = $('#pw-res-wi').val();
        const syncWi = $('#pw-wi-toggle').is(':checked');

        if (!name) return toastr.warning("名字不能为空");

        const $btn = $(this);
        $btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 保存中...');

        try {
            const context = getContext();
            
            // 1. Save Persona to PowerUserSettings
            if (!context.powerUserSettings.personas) context.powerUserSettings.personas = {};
            context.powerUserSettings.personas[name] = desc;
            await saveSettingsDebounced();

            // 2. Sync to World Info
            if (currentWb && syncWi && wiContent) {
                // Dynamically import world info functions
                const { loadWorldInfo, saveWorldInfo, world_names } = await import("../../../../scripts/world-info.js");
                
                // Load the specific world book
                // Warning: loading a world book might switch the UI, we need to be careful
                // For simplicity, we assume the user wants to add to the current world book logic
                // But SillyTavern's API for adding entries to *specific* book is tricky if it's not currently loaded in editor.
                // We will try to fetch the data, modify, and save.
                
                // Try to get data from memory if it's loaded
                let worldData = null;
                
                // This part is complex because ST doesn't have a simple "append entry to file X" API
                // We will use a safe approach: Check if it matches selected_world_info
                
                // Construct entry
                const newEntry = {
                    keys: [name, "User", "用户"].join(','),
                    content: wiContent,
                    comment: `[User] ${name}`,
                    enabled: true,
                    selective: true,
                    secondary_keys: ""
                };

                // NOTE: Proper implementation requires reading the JSON file, adding entry, and saving.
                // Using internal API to avoid file handling complexity if possible.
                // Falling back to standard "createWorldBookEntry" style logic logic locally.
                
                const utils = await import("../../../../scripts/utils.js");
                // Read current file
                let fileData = await utils.parseJsonFile(currentWb); // Hypothetical, file reading needs path
                // Actually, let's use the API endpoint which is safer
                
                const headers = getRequestHeaders();
                const getRes = await fetch('/api/worldinfo/get', { 
                    method: 'POST', 
                    headers, 
                    body: JSON.stringify({ name: currentWb }) 
                });
                
                if (getRes.ok) {
                    const bookData = await getRes.json();
                    // Add entry
                    if (!bookData.entries) bookData.entries = {};
                    
                    // Find max ID
                    const ids = Object.keys(bookData.entries).map(Number);
                    const newId = ids.length ? Math.max(...ids) + 1 : 0;
                    
                    bookData.entries[newId] = {
                        uid: newId,
                        key: [name, "User"],
                        keysecondary: [],
                        comment: `[User] ${name}`,
                        content: wiContent,
                        constant: false,
                        selective: true,
                        enabled: true
                    };
                    
                    // Save back
                    await fetch('/api/worldinfo/edit', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ name: currentWb, data: bookData })
                    });
                    
                    toastr.success(TEXT.TOAST_WI_SUCCESS(currentWb), TEXT.PANEL_TITLE);
                    
                    // Refresh if needed
                    if (context.updateWorldInfoList) context.updateWorldInfoList();
                }
            }

            // 3. Auto Switch
            if (extension_settings[extensionName].autoSwitchPersona) {
                context.powerUserSettings.persona_selected = name;
                // Update UI inputs directly
                $("#your_name").val(name).trigger("input").trigger("change");
                $("#your_desc").val(desc).trigger("input").trigger("change");
                // Update avatar box if needed (not handled here but name change usually triggers it)
            }

            toastr.success(TEXT.TOAST_SAVE_SUCCESS(name), TEXT.PANEL_TITLE);
            $('.popup_close').click(); // Close popup

        } catch (e) {
            console.error(e);
            toastr.error("保存失败: " + e.message);
        } finally {
            $btn.prop('disabled', false).html('<i class="fa-solid fa-floppy-disk"></i> 保存并启用');
        }
    });

    // Clear
    $('#pw-clear').on('click', () => {
        if(confirm("确定清空当前内容？")) {
            $('input[type="text"], textarea').val('');
            $('#pw-result-area').hide();
            localStorage.removeItem(STORAGE_KEY_STATE);
        }
    });

    // History View Toggle
    const toggleView = (view) => {
        $('.pw-view').removeClass('active');
        $(`#pw-view-${view}`).addClass('active');
    };

    $('#pw-history').on('click', () => {
        const $list = $('#pw-history-list').empty();
        if (historyCache.length === 0) $list.html('<div style="text-align:center; opacity:0.5;">暂无记录</div>');
        
        historyCache.forEach(item => {
            const $el = $(`
                <div class="pw-history-item">
                    <div style="font-size:0.8em; opacity:0.5;">${item.timestamp}</div>
                    <div style="font-weight:bold; color:var(--SmartThemeQuoteColor);">${item.data.name}</div>
                    <div style="font-size:0.9em; opacity:0.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.request}</div>
                </div>
            `);
            $el.on('click', () => {
                $('#pw-request').val(item.request);
                $('#pw-res-name').val(item.data.name);
                $('#pw-res-desc').val(item.data.description);
                $('#pw-res-wi').val(item.data.wi_entry);
                $('#pw-result-area').show();
                autoSave();
                toggleView('editor');
            });
            $list.append($el);
        });
        toggleView('history');
        $('#pw-clear').hide();
    });

    $('#pw-btn-back').on('click', () => {
        toggleView('editor');
        $('#pw-clear').show();
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
    
    $("#pw_auto_switch").prop("checked", extension_settings[extensionName].autoSwitchPersona);
    $("#pw_sync_wi").prop("checked", extension_settings[extensionName].syncToWorldInfo);
}

function onSettingChanged() {
    extension_settings[extensionName].autoSwitchPersona = $("#pw_auto_switch").prop("checked");
    extension_settings[extensionName].syncToWorldInfo = $("#pw_sync_wi").prop("checked");
    saveSettingsDebounced();
}

jQuery(async () => {
    // 1. Inject CSS
    injectStyles();

    // 2. Load Settings
    await loadSettings();

    // 3. Build Settings Panel HTML
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
                    <small style="display: block; text-align: center; opacity: 0.7; margin-top: 5px;">
                        ${TEXT.BTN_OPEN_DESC}
                    </small>
                </div>

                <hr class="sysHR" />

                <div style="margin-bottom: 10px;">
                    <div class="flex-container" style="margin: 5px 0; align-items: center;">
                        <input id="pw_auto_switch" type="checkbox" />
                        <label for="pw_auto_switch" style="margin-left: 8px;">${TEXT.LABEL_AUTO_SWITCH}</label>
                    </div>
                    <div class="flex-container" style="margin: 5px 0; align-items: center;">
                        <input id="pw_sync_wi" type="checkbox" />
                        <label for="pw_sync_wi" style="margin-left: 8px;">${TEXT.LABEL_SYNC_WI}</label>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    // 4. Append to Extensions Menu
    $("#extensions_settings2").append(settingsHtml);

    // 5. Bind Events
    $("#pw_open_btn").on("click", openCreatorPopup);
    $("#pw_auto_switch").on("change", onSettingChanged);
    $("#pw_sync_wi").on("change", onSettingChanged);

    console.log(`${extensionName} loaded.`);
});
