

const lightServerMode = true;

window.URL = window.URL || window.webkitURL || window.mozURL || window.oURL || window.msURL;

const loaderTimeout = 10;

let allLoaded = false;

let usingWebGL = false;

let AudioPlayerConstructor = null;

if (Modernizr.webaudio) {
    AudioPlayerConstructor = WebAudioPlayer;
}

const canPlayMp3 = true;


let loggedIn = false;
let user = null;
let userInfo = null;

const globalRnd = new MersenneTwister();
const globalGenInfo = new GenInfo();

let settingsDirty = false;

let songSettingsChangedWhileRendering = false;

let audioPlayer = null;

const uidManager = new UniqueIdManager();


let songSettingsCompInfo = null;

let songSettingsDirty = false;

let asyncOperations = [];
let asyncOperationCounter = 0;


const propertyInfoProvider = new PropertyInfoProvider();


let visualizer = null;

let $playButton = null;
let $stopButton = null;
let $forwardButton = null;
let $rewindButton = null;

let $refreshButton = null;

function getMainSeed() {
    let seed = 213124;

    if (songSettings.seed) {
        const tempSeed = parseInt(songSettings.seed);

        if (isNaN(tempSeed)) {
            seed = hashCode(songSettings.seed);
        } else {
            seed = tempSeed;
        }
    }
    return seed;
}



function getSeedStringsObject(reference, genInfo) {
    const result = {};
    for (const prop in reference) {
        if (prop.indexOf("Seed") >= 0) {
            const seed = genInfo[prop];
            if (typeof(seed) != 'undefined') {
                result[prop] = "" + seed;
            } else {
                result[prop] = "";
            }
        }
    }
    return result;
}

function getSeeds(result, settings) {
    for (const prop in settings) {
        if (prop.indexOf("Seed") >= 0) {
            const seedStr = settings[prop];
            if (seedStr) {
                let seed = parseInt(seedStr);

                if (isNaN(seed)) {
                    seed = hashCode(seedStr);
                }
                if (!isNaN(seed)) {
                    result[prop] = seed;
                }
            }
        }
    }
}

function copyWithPropertyInfoProvider(result, settings, source) {
    if (!result) {
        result = {};
    }
    if (!source) {
        source = settings;
    }
    const infos = propertyInfoProvider.getGuiPropertyInfos(settings).getIterator();

    for (const info of infos) {
        const value = source[info.propertyName];
        if (!isFunction(value)) {
            result[info.propertyName] = value;
        }
    }
    return result;
}


function getGenInfo() {
    const result = {};

    getSeeds(result, songStructureSeedSettings);
    getSeeds(result, songContentSeedSettings);
    getSeeds(result, songIndicesSeedSettings);

    copyWithPropertyInfoProvider(result, songParameters);
    copyWithPropertyInfoProvider(result, songDomains);
    copyWithPropertyInfoProvider(result, songDetails);

    return result;
}



function showModalDialog(title, content, options) {
    const $dialog = $("<div title=\"" + title + "\" >" + content + "</div>");

    $("#dialogsdiv").append($dialog);

    if (!options) {
        options = {
            modal: true,
            buttons: {
                "Ok": function() {
                    $( this ).dialog( "close" );
                }
            }
        }
    }
    $dialog.dialog(options);

    return $dialog;
}

function showConfirmDialog(title, content, yesCaption, noCaption, yesCallback, noCallback) {

    const buttons = {};
    buttons[yesCaption] = function() {
        $(this).dialog("close");
        if (yesCallback) {
            yesCallback();
        }
    };
    buttons[noCaption] = function() {
        $(this).dialog("close");
        if (noCallback) {
            noCallback();
        }
    };

    const options = {
        modal: true,
        buttons: buttons
    };
    return showModalDialog(title, content, options);
}


function setSongSettingsDirty(val) {
    songSettingsDirty = val;

    if ($refreshButton) {
        $refreshButton.button("option", "disabled", !val);
    }
}

let $latestAudioElement = null;
let exportTimeout = null;
let tempTempoEvents = null;

function afterExport(op) {
    stopSong();
    updateRenderStorageAndVisualizer(op);

    if (op.$audioElement) {
        $latestAudioElement = op.$audioElement;

        function updateExportPlayer() {
            if ($latestAudioElement && $latestAudioElement[0]) {
                const time = $latestAudioElement[0].currentTime;
                if (time) {
                    const beat = predictBeat(tempTempoEvents, time);
//                    logit("predicted beat " + beat + " from " + time);
                    visualizer.setCurrentPlayBeatTime(beat);
                }
                exportTimeout = setTimeout(updateExportPlayer, 100);
            }
        }

        $latestAudioElement.on("play", () => {
            visualizer.setMode(VisualizerMode.PLAY);
            visualizer.setCurrentPlayBeatTime(0);
            updateExportPlayer();
        });
        $latestAudioElement.on("pause", () => {
            visualizer.setMode(VisualizerMode.PAUSE);
        });
        $latestAudioElement.on("stop", () => {
            visualizer.setMode(VisualizerMode.STOP);
            visualizer.setCurrentPlayBeatTime(0);
        });
    } else {
        $latestAudioElement = null;
    }
}

function joinNotEmpty(arr, str) {
    const newArr = [];
    for (let i=0; i<arr.length; i++) {
        if (arr[i]) {
            newArr.push(arr[i]);
        }
    }
    return newArr.join(str);
}

const exportSupportArr = [
    (window.ArrayBuffer ? "" : "Array Buffer"),
    (window.DataView ? "" : "Data View"),
    (window.URL ? "" : "URL object"),
    (Modernizr.webworkers ? "" : "Web Workers"),
    (Modernizr.blobconstructor ? "" : "Blob Constructor")
];

function exportMidi() {

    const clientExportSupport = Modernizr.webworkers && Modernizr.blobconstructor && window.URL && window.ArrayBuffer && window.DataView;

    if (lightServerMode && !clientExportSupport) {
        showModalDialog("Midi Export Not Supported by this browser",
            "The browser need support for " + joinNotEmpty(exportSupportArr, ", "));
    } else {
        const seed = getMainSeed();
        const genInfo = getGenInfo();
        copyWithPropertyInfoProvider(genInfo, midiExportSettings);

        delete genInfo.export2;

        const renderRequestData = {seed: seed, strSeed: songSettings.seed, name: songSettings.name, sectionIndex: -1, genInfo: genInfo};

        const params = {
            taskType: AsyncServerChildTaskType.EXPORT_MIDI,
            content: renderRequestData,
            caption: "Exporting midi...",
            doneCaption: "Done!",
            resultDivId: "midi-export-result-div",
            onSuccess: function(op) {
                afterExport(op);
            },
            id: "task" + asyncOperationCounter};

        let task = null;
        if (clientExportSupport) {
            params.taskType = WorkerTaskType.EXPORT_MIDI;
            task = new AsyncWorkerTask(params);
        } else {
            task = new AsyncServerChildTask(params);
        }
        addAsyncOperation(task);
    }

}


function exportWav() {

    const clientExportSupport = Modernizr.webworkers && Modernizr.blobconstructor && window.URL && window.ArrayBuffer && window.DataView;

    if (lightServerMode && !clientExportSupport) {
        showModalDialog("Wav Export Not Supported by this browser",
            "The browser need support for " + joinNotEmpty(exportSupportArr, ", "));
    } else {
        const seed = getMainSeed();
        const genInfo = getGenInfo();

        if (clientExportSupport) {
            copyWithPropertyInfoProvider(genInfo, wavClientExportSettings);
        } else {
            copyWithPropertyInfoProvider(genInfo, wavExportSettings);
        }

        delete genInfo.export2;

        const renderRequestData = {seed: seed, strSeed: songSettings.seed, name: songSettings.name, sectionIndex: -1, genInfo: genInfo};

        const params = {
            taskType: AsyncServerChildTaskType.EXPORT_WAV,
            content: renderRequestData,
            caption: "Exporting wav...",
            doneCaption: "Done!",
            resultDivId: "wav-export-result-div",
            onSuccess: function(op) {
                afterExport(op);
            },
            id: "task" + asyncOperationCounter};

        let task = null;
        if (clientExportSupport) {
            params.taskType = WorkerTaskType.EXPORT_WAV;
            task = new AsyncWorkerTask(params);
        } else {
            task = new AsyncServerChildTask(params);
        }
        addAsyncOperation(task);
    }

}


function exportIT() {
    showModalDialog("", "IT export not implemented.");
}

function savePreset() {
    const seed = getMainSeed();
    const genInfo = getGenInfo();
    copyWithPropertyInfoProvider(genInfo, mp3ExportSettings);

    const renderRequestData = {seed: seed, sectionIndex: -1, genInfo: genInfo};

    const task = new AsyncServerChildTask({
        taskType: AsyncServerChildTaskType.SAVE_PRESET,
        content: renderRequestData,
        caption: "Saving preset...",
        doneCaption: "Done!",
        requireLogin: false,
        resultDivId: "",
        id: "task" + asyncOperationCounter});
    addAsyncOperation(task);
}

function exportMp3() {

    if (lightServerMode) {
        showModalDialog("Mp3 Export Not Supported",
            "The server doesn't support this operation and you can not do this in the browser yet.");
    } else {
        const seed = getMainSeed();
        const genInfo = getGenInfo();
        copyWithPropertyInfoProvider(genInfo, mp3ExportSettings);

        const renderRequestData = {seed: seed, sectionIndex: -1, genInfo: genInfo};
        const curOperation = false; // getFirstRunningServerTaskWithType(AsyncServerChildTaskType.EXPORT_MP3);

        const task = new AsyncServerChildTask({
            taskType: AsyncServerChildTaskType.EXPORT_MP3,
            content: renderRequestData,
            caption: "Exporting mp3...",
            doneCaption: "Done!",
            resultDivId: "mp3-export-result-div",
            onSuccess: function(op) {
                afterExport(op);
            },
            id: "task" + asyncOperationCounter});
        addAsyncOperation(task);
    }
}

function exportOgg() {
    if (lightServerMode) {
        showModalDialog("Mp3 Export Not Supported",
            "The server doesn't support this operation and you can not do this in the browser yet.");
    } else {
        const seed = getMainSeed();
        const genInfo = getGenInfo();
        copyWithPropertyInfoProvider(genInfo, oggExportSettings);

        const renderRequestData = {seed: seed, sectionIndex: -1, genInfo: genInfo};
        const curOperation = getFirstRunningServerTaskWithType(AsyncServerChildTaskType.EXPORT_OGG);

        const task = new AsyncServerChildTask({
            taskType: AsyncServerChildTaskType.EXPORT_OGG,
            content: renderRequestData,
            caption: "Exporting ogg...",
            doneCaption: "Done!",
            resultDivId: "ogg-export-result-div",
            onSuccess: function(op) {
                afterExport(op);
            },
            id: "task" + asyncOperationCounter});
        addAsyncOperation(task);
    }
}


function updateAsyncOperations() {
    const nextOps = [];

    for (const op of asyncOperations) {
        op.update();
        if (!op.done && !op.cancelled) {
            nextOps.push(op);
        }
    }

    asyncOperations = nextOps;
    if (asyncOperations.length > 0) {
        setTimeout(updateAsyncOperations, 500);
    }
}

function addAsyncOperation(op) {
    if (!op) {
        return false;
    }
    if (loggedIn || !op.requireLogin) {
        asyncOperations.push(op);
        op.start();
        updateAsyncOperations();
        asyncOperationCounter++;
        return true;
    } else {
        showModalDialog("Not logged in", "You must log in to export or compose new songs.");
        return false;
    }
}


function logit(str) {
    console.log(str);
}

function getFirstRunningServerTaskWithType(type) {
    for (const op of asyncOperations) {
        if (op.taskType == type) {
            return op;
        }
    }

    return null;
}


function createExportPanel() {
    const tabCaptions = ["Midi", "Mp3", "Ogg", "IT"];
    const tabObjects = [midiExportSettings, mp3ExportSettings, oggExportSettings, itExportSettings];
    const tabObjectPresets = [midiExportSettingsPresets, mp3ExportSettingsPresets, oggExportSettingsPresets, itExportSettingsPresets];

    if (lightServerMode) {
        tabCaptions.length = 1;
        tabObjects.length = 1;
        tabObjectPresets.length = 1;
//        tabCaptions.push("Wav (Alpha)");
//        tabObjects.push(wavClientExportSettings);
//        tabObjectPresets.push(wavClientExportSettingsPresets);
    }
    SongSettingsComponent.createTabs($("#exportDialogDiv"), "exportTab", "export-panel", tabCaptions, tabObjects,
        () => {
            settingsDirty = true;
        }, tabObjectPresets);

    if (lightServerMode) {
        $("#exportTab0").prepend($("<div id=\"midi-export-result-div\" ></div>"));
//        $("#exportTab1").prepend($("<div id=\"wav-export-result-div\" ></div>"));
    } else {
        $("#exportTab0").prepend($("<div id=\"midi-export-result-div\" ></div>"));
        $("#exportTab1").prepend($("<div id=\"mp3-export-result-div\" ></div>"));
        $("#exportTab2").prepend($("<div id=\"ogg-export-result-div\" ></div>"));
        $("#exportTab3").prepend($("<div id=\"it-export-result-div\" ></div>"));
    }

}


function createMidiImportPanel($div, idPrefix) {
    idPrefix = idPrefix || "midiImport";
    $div.empty();

    let latest = {
        fileName: null,
        analysis: null,
        genInfo: null,
        preset: null,
        seed: null
    };

    let content = "";
    content += "<div class=\"midi-import-panel\" >";
    content += "<p>Upload a .mid/.midi file to derive a preset (tempo / time signature / key + a rough instrument-type guess).</p>";
    content += "<div style=\"margin: 0.5em 0;\" >";
    content += "  <label for=\"" + idPrefix + "FormSelect\" style=\"margin-right: 0.5em;\" >Form mode</label>";
    content += "  <select id=\"" + idPrefix + "FormSelect\" >";
    content += "    <option value=\"auto\" selected=\"selected\" >Auto (recommended)</option>";
    content += "    <option value=\"loop\" >Loop / Monotone (no chorus)</option>";
    content += "    <option value=\"verseChorus\" >Verse / Chorus</option>";
    content += "    <option value=\"build\" >Build</option>";
    content += "  </select>";
    content += "</div>";
    content += "<input type=\"file\" id=\"" + idPrefix + "FileInput\" accept=\".mid,.midi,audio/midi,audio/x-midi\" />";
    content += "<div style=\"margin-top: 0.75em;\" >";
    content += "  <button id=\"" + idPrefix + "ApplyButton\" disabled=\"disabled\" >Apply To Song Settings</button>";
    content += "  <button id=\"" + idPrefix + "DownloadButton\" disabled=\"disabled\" style=\"margin-left: 0.5em;\" >Download Preset JSON</button>";
    content += "</div>";
    content += "<div id=\"" + idPrefix + "ResultDiv\" style=\"margin-top: 0.75em; font-size: 0.95em;\" ></div>";
    content += "</div>";

    $div.append($(content));

    const $fileInput = $("#" + idPrefix + "FileInput");
    const $formSelect = $("#" + idPrefix + "FormSelect");
    const $applyButton = $("#" + idPrefix + "ApplyButton");
    const $downloadButton = $("#" + idPrefix + "DownloadButton");
    const $resultDiv = $("#" + idPrefix + "ResultDiv");

    function setButtonsEnabled(enabled) {
        $applyButton.button("option", "disabled", !enabled);
        $downloadButton.button("option", "disabled", !enabled);
    }

    function yyyymmddSeed() {
        const d = new Date();
        const y = d.getFullYear();
        const m = (d.getMonth() + 1);
        const day = d.getDate();
        return (y * 10000) + (m * 100) + day;
    }

    function showError(err) {
        const msg = (err && err.message) ? err.message : ("" + err);
        $resultDiv.empty();
        $resultDiv.append($("<div style=\"color: #a00;\" />").text("Failed to read MIDI: " + msg));
        latest = { fileName: null, analysis: null, genInfo: null, preset: null };
        setButtonsEnabled(false);
    }

    function analyzeFile(file) {
        if (!file) {
            return;
        }

        const reader = new FileReader();
        reader.onerror = () => showError(reader.error || new Error("FileReader error"));
        reader.onload = () => {
            try {
                const arrayBuffer = reader.result;
                const parsed = MidiImport.parseSmf(arrayBuffer);
                const analysis = MidiImport.analyzeMergedEvents(parsed.mergedEvents, { midiDivisions: parsed.midiData.midiDivisions });
                const seed = yyyymmddSeed();

                latest.fileName = file.name;
                latest.analysis = analysis;
                latest.seed = seed;

                const summaryLines = MidiImport.summarizeAnalysis(analysis);

                $resultDiv.empty();
                if (summaryLines.length) {
                    const $ul = $("<ul />");
                    for (const line of summaryLines) {
                        $ul.append($("<li />").text(line));
                    }
                    $resultDiv.append($ul);
                } else {
                    $resultDiv.append($("<div />").text("Parsed MIDI, but no tempo/time-signature/key metadata was found."));
                }

                setButtonsEnabled(true);
            } catch (e) {
                showError(e);
            }
        };

        reader.readAsArrayBuffer(file);
    }

    $applyButton.button().click(() => {
        if (!latest || !latest.analysis) {
            return;
        }
        const formMode = $formSelect.val() || "auto";
        const genInfo = MidiImport.analysisToGenInfo(latest.analysis, { formMode: formMode });
        const preset = MidiImport.createPresetObject(genInfo, { seed: latest.seed || yyyymmddSeed() });

        const newSongSettings = {
            name: latest.fileName ? ("MIDI: " + latest.fileName) : "MIDI Import",
            seed: "" + preset.seed
        };
        updateSongSettingsComponent(genInfo, newSongSettings);
        settingsDirty = true;
        setSongSettingsDirty(true);
        showModalDialog("Applied", "<p>Applied extracted settings to Song Settings.</p>");
    });

    $downloadButton.button().click(() => {
        if (!latest || !latest.analysis) {
            return;
        }
        const formMode = $formSelect.val() || "auto";
        const genInfo = MidiImport.analysisToGenInfo(latest.analysis, { formMode: formMode });
        const preset = MidiImport.createPresetObject(genInfo, { seed: latest.seed || yyyymmddSeed() });
        const baseName = latest.fileName ? latest.fileName.replace(/\.[^.]+$/, "") : "midi";
        MidiImport.downloadJsonObject(preset, baseName + "_preset.json");
    });

    $applyButton.button({ disabled: true });
    $downloadButton.button({ disabled: true });

    $fileInput.on("change", () => {
        const file = $fileInput[0].files && $fileInput[0].files[0];
        analyzeFile(file);
    });
}


function createPresetJsonImportPanel($div, idPrefix) {
    idPrefix = idPrefix || "presetJson";
    $div.empty();

    let latest = {
        fileName: null,
        parsed: null
    };

    let content = "";
    content += "<div class=\"preset-json-import-panel\" >";
    content += "<p>Load a JSON preset from disk. Supports both preset JSON ({seed, genInfo}) and full song JSON exports ({seed, genInfo, renderData,...}).</p>";
    content += "<input type=\"file\" id=\"" + idPrefix + "FileInput\" accept=\"application/json,.json\" />";
    content += "<div style=\"margin-top: 0.75em;\" >";
    content += "  <button id=\"" + idPrefix + "ApplyButton\" disabled=\"disabled\" >Apply To Song Settings</button>";
    content += "</div>";
    content += "<div id=\"" + idPrefix + "ResultDiv\" style=\"margin-top: 0.75em; font-size: 0.95em;\" ></div>";
    content += "</div>";

    $div.append($(content));

    const $fileInput = $("#" + idPrefix + "FileInput");
    const $applyButton = $("#" + idPrefix + "ApplyButton");
    const $resultDiv = $("#" + idPrefix + "ResultDiv");

    function setEnabled(enabled) {
        $applyButton.button("option", "disabled", !enabled);
    }

    function showError(err) {
        const msg = (err && err.message) ? err.message : ("" + err);
        $resultDiv.empty();
        $resultDiv.append($("<div style=\"color: #a00;\" />").text("Failed to read JSON: " + msg));
        latest = { fileName: null, parsed: null };
        setEnabled(false);
    }

    function showSummary(obj) {
        const lines = [];
        const hasGenInfo = !!(obj && obj.genInfo);
        const hasRender = !!(obj && obj.renderData && obj.channelMaps);
        const seed = (obj && typeof obj.seed !== 'undefined') ? obj.seed : null;
        lines.push("Contains genInfo: " + (hasGenInfo ? "yes" : "no"));
        lines.push("Contains rendered data: " + (hasRender ? "yes" : "no"));
        if (seed != null) {
            lines.push("Seed: " + seed);
        }

        $resultDiv.empty();
        const $ul = $("<ul />");
        for (const l of lines) {
            $ul.append($("<li />").text(l));
        }
        $resultDiv.append($ul);
    }

    function readFile(file) {
        if (!file) {
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => showError(reader.error || new Error("FileReader error"));
        reader.onload = () => {
            try {
                const text = reader.result;
                const obj = JSON.parse(text);
                latest.fileName = file.name;
                latest.parsed = obj;
                showSummary(obj);

                // Enable apply if it looks like either {genInfo:...} or a raw genInfo object.
                const looksValid = !!(obj && (obj.genInfo || obj.tempoRange || obj.majorScaleLikelihood || obj._constructorName === "GenInfo"));
                setEnabled(looksValid);
            } catch (e) {
                showError(e);
            }
        };
        reader.readAsText(file);
    }

    $applyButton.button({ disabled: true }).click(() => {
        if (!latest || !latest.parsed) {
            return;
        }
        const obj = latest.parsed;
        const name = latest.fileName ? ("Preset: " + latest.fileName) : "Preset";
        applyLoadedSongObject(obj, {name: name, autoRender: false});
        showModalDialog("Applied", "<p>Applied JSON preset to Song Settings.</p>");
    });

    $fileInput.on("change", () => {
        const file = $fileInput[0].files && $fileInput[0].files[0];
        readFile(file);
    });
}


function createSongImportToolsPanel() {
    const $songTab = $("#songSettingsTab0");
    if (!$songTab.length) {
        return;
    }

    $("#songToolsPanel").remove();

    const $tools = $(
        "<div id=\"songToolsPanel\" style=\"margin-bottom: 1em;\" >" +
        "  <h3 style=\"margin: 0.3em 0;\" >Import</h3>" +
        "  <div id=\"songToolsPresetImport\" style=\"margin-bottom: 1em; padding-bottom: 0.5em; border-bottom: 1px solid #ddd;\" ></div>" +
        "  <div id=\"songToolsMidiImport\" ></div>" +
        "</div>"
    );

    $songTab.prepend($tools);

    createPresetJsonImportPanel($("#songToolsPresetImport"), "songPresetImport");
    createMidiImportPanel($("#songToolsMidiImport"), "songMidiImport");
}


function createSongInfoPanel() {
    const $songInfoDiv = $("#songInfoTabs");
    $songInfoDiv.tabs();
}

function getSongPartName(i, songStructureInfo) {

    let text = "Part";

    const indexInfo = songStructureInfo.indexInfos[i];

    const songPartType = songStructureInfo.songPartTypes[i];
    if (indexInfo.isIntro) {
        text = "Intro";
    } else if (indexInfo.isEnd) {
        text = "End";
    } else if (indexInfo.isConnectGroup) {
        text = "Connect";
        if (indexInfo.isPostfixGroup) {
            text = "Postfix";
        } else if (indexInfo.isPrefixGroup) {
            text = "Prefix";
        }
    } else {
        switch (songPartType) {
            case 0:
            case 1:
                text = "Verse " + (songPartType + 1);
                break;
            case 2:
            case 3:
                text = "Chorus " + (songPartType - 1);
                break;
            case 4:
            case 5:
                text = "Bridge " + (songPartType - 3);
                break;
            case 6:
            case 7:
                text = "Misc " + (songPartType - 5);
                break;
        }
        if (indexInfo.phraseGroupCount > 1) {
            text += ", " + (indexInfo.phraseGroupIndex + 1);
        }
    }

    return text;
}

function updateSongInfoPanel() {
    const $structureDiv = $("#songInfoTabStructure");
    const $instrumentsDiv = $("#songInfoTabInstruments");

    $instrumentsDiv.empty();
    $structureDiv.empty();


    const songStructureInfo = renderStorage.songStructureInfo;

    const rowClasses = ['evenTableRow', 'oddTableRow'];

    if (songStructureInfo) {
        const indexInfos = songStructureInfo.indexInfos;
        let htmlArr = [];
        htmlArr.push('<table class="songInfoInstrumentsTable">');
        let rowIndex = 0;

        function getPropertyTableRow(header, arr) {
            const rowClass = rowClasses[rowIndex % rowClasses.length];
            htmlArr.push('<tr class="' + rowClass + '">');
            htmlArr.push('<td>' + header + '</td>')
            for (let i=0; i<arr.length; i++) {
                const text = '' + arr[i];
                htmlArr.push('<td>' + text + '</td>');
            }
            rowIndex++;
        }

        if (indexInfos) {
//            logit(songStructureInfo);
            let rowClass = rowClasses[rowIndex % rowClasses.length];
            htmlArr.push('<tr class="' + rowClass + '">');
            htmlArr.push('<td>Type</td>')
            for (let i=0; i<indexInfos.length; i++) {
                const text = getSongPartName(i, songStructureInfo);
                htmlArr.push('<td>' + text + '</td>');
            }
            htmlArr.push('</tr>');
            rowIndex++;
            getPropertyTableRow("Harmony Rythm", songStructureInfo.harmonyRythmIndices);
            getPropertyTableRow("Harmony Char.", songStructureInfo.harmonyExtraIndices);
            getPropertyTableRow("Melody Shape", songStructureInfo.melodyShapeIndices);
            getPropertyTableRow("Bass Shape", songStructureInfo.bassShapeIndices);
            getPropertyTableRow("Melody Motif Dist.", songStructureInfo.melodyMotifDistributionIndices);
            getPropertyTableRow("Bass Motif Dist.", songStructureInfo.bassMotifDistributionIndices);
            getPropertyTableRow("Inner 1 Motif Dist.", songStructureInfo.inner1MotifDistributionIndices);
            getPropertyTableRow("Inner 2 Motif Dist.", songStructureInfo.inner2MotifDistributionIndices);
            getPropertyTableRow("Percussion Dist.", songStructureInfo.percussionMotifDistributionIndices);
            getPropertyTableRow("Percussion Fill Dist.", songStructureInfo.percussionFillMotifDistributionIndices);
            getPropertyTableRow("Melody Instr.", songStructureInfo.melodyChannelDistributionIndices);
            getPropertyTableRow("Bass Instr.", songStructureInfo.bassChannelDistributionIndices);
            getPropertyTableRow("Inner 1 Instr.", songStructureInfo.inner1ChannelDistributionIndices);
            getPropertyTableRow("Inner 2 Instr.", songStructureInfo.inner2ChannelDistributionIndices);
            getPropertyTableRow("Melody Effects", songStructureInfo.sequentialMelodyEffectChangeIndices);
            getPropertyTableRow("Bass Effects", songStructureInfo.sequentialBassEffectChangeIndices);
            getPropertyTableRow("Inner 1 Effects", songStructureInfo.sequentialInner1EffectChangeIndices);
            getPropertyTableRow("Inner 2 Effects", songStructureInfo.sequentialInner2EffectChangeIndices);
            getPropertyTableRow("Percussion Effects", songStructureInfo.sequentialPercussionEffectChangeIndices);
        }
        htmlArr.push('</table>');

        $structureDiv.append(htmlArr.join(""));
    }

    const channelMaps = renderStorage.channelMaps;
    if (channelMaps) {
        let htmlArr = [];
        htmlArr.push('<table class="songInfoInstrumentsTable">');
        for (let i=0; i<channelMaps.length-1; i++) {
            let rowClass = rowClasses[i % rowClasses.length];
            htmlArr.push('<tr class="' + rowClass + '">');
            const chMap = channelMaps[i];
            const str = MidiProgram.toString(chMap.program);
            let instrStr = "Unknown";
            switch (i) {
                case 0:
                case 1:
                case 2:
                    instrStr = "Melody instrument " + (i + 1);
                    break;
                case 3:
                case 4:
                case 5:
                    instrStr = "Inner 1 instrument " + (i + 2);
                    break;
                case 6:
                case 7:
                case 8:
                    instrStr = "Inner 2 instrument " + (i - 5);
                    break;
                case 9:
                case 10:
                case 11:
                    instrStr = "Bass instrument " + (i - 8);
                    break;
            }
            htmlArr.push('<td>' + instrStr + '</td>');
            htmlArr.push('<td>' + str + '</td>');
//            htmlArr.push(str + '<br />');
            htmlArr.push("</tr>");
        }
        htmlArr.push('</table>');
        $instrumentsDiv.append(htmlArr.join(""));
    }
}


function deleteSong(songIndex, callback) {

    showConfirmDialog("Really delete?", "Do you really want to delete the song?", "Yes", "No",
        () => {
            const deleteRequestData = {songIndex: songIndex};
            const task = new AsyncServerChildTask({
                taskType: AsyncServerChildTaskType.DELETE_SONG,
                content: deleteRequestData,
                caption: "Deleting song...",
                doneCaption: "Done!",
                resultDivId: "",
                onDone: function(op) {
                    callback();
                },
                id: "task" + asyncOperationCounter});
            addAsyncOperation(task);
        },
        () => {
        });
}

function renameSong(songIndex, newName, callback) {
    const deleteRequestData = {newName: newName, songIndex: songIndex};
    const task = new AsyncServerChildTask({
        taskType: AsyncServerChildTaskType.RENAME_SONG,
        content: deleteRequestData,
        caption: "Renaming song...",
        doneCaption: "Done!",
        resultDivId: "",
        onDone: function(op) {
            callback();
        },
        id: "task" + asyncOperationCounter});
    addAsyncOperation(task);
}

function overwriteSong(prefix, songInfo) {
    const seed = getMainSeed();
    const name = songSettings.name;
    const genInfo = getGenInfo();
    copyWithPropertyInfoProvider(genInfo, mp3ExportSettings);

    const owRequestData = {seed: seed, songName: name, prefix: songInfo.prefix, genInfo: genInfo};

    const task = new AsyncServerChildTask({
        taskType: AsyncServerChildTaskType.OVERWRITE_SONG,
        content: owRequestData,
        caption: "Overwriting song...",
        doneCaption: "Done!",
        resultDivId: "",
        onDone: function() {
            loadMySongsList();
        },
        id: "task" + asyncOperationCounter});
    if (!addAsyncOperation(task)) {
        logit("Failed to add async op for overwrite song?");
    }

}

function completeGenInfo(genInfo) {
    const refGenInfo = new GenInfo();
    for (const prop in refGenInfo) {
        if (!stringEndsWith(prop, "Seed")) {
            const refValue = refGenInfo[prop];
            const value = genInfo[prop];
            if (!isFunction(refValue) && typeof(value) === 'undefined') {
                genInfo[prop] = copyValueDeep(refValue);
//                logit("Completing gen info " + prop + ": " + refValue);
            }
        }
    }
}


function updateSongSettingsComponent(genInfo, newSongSettings) {

    const tabsId = "songSettingsTab";

    completeGenInfo(genInfo);
    const newValues = [
        newSongSettings,
        getSeedStringsObject(songStructureSeedSettings, genInfo),
        getSeedStringsObject(songContentSeedSettings, genInfo),
        getSeedStringsObject(songIndicesSeedSettings, genInfo),
        copyWithPropertyInfoProvider(null, songParameters, genInfo),
        copyWithPropertyInfoProvider(null, songDomains, genInfo),
        copyWithPropertyInfoProvider(null, songDetails, genInfo)
    ];

    for (let i=0; i<newValues.length; i++) {
        SongSettingsComponent.changeComponentValue(newValues[i], songSettingsCompInfo.createdComps, i, tabsId, songSettingsCompInfo.changeListener);
    }

}


function applyLoadedSongObject(response, options) {
    options = options || {};
    if (!response) {
        return;
    }

    // Support both full song JSON ({seed, genInfo, ...}) and raw genInfo JSON.
    const genInfo = response.genInfo ? response.genInfo : response;
    const seed = (typeof response.seed !== 'undefined') ? response.seed : getMainSeed();
    const name = getValueOrDefault(options, "name", "Song");

    updateSongSettingsComponent(genInfo, {name: name, seed: "" + seed});

    if (response.channelMaps && response.renderData) {
        // Presets with rendered data
        stopSong();
        renderStorage.channelMaps = response.channelMaps;
        renderStorage.renderData = response.renderData;
        renderStorage.renderDataLength = Math.max(1, response.renderDataLength);
        renderStorage.dirty = true;
        settingsDirty = true;
        visualizer.resetRenderData();
        visualizer.addRenderData(renderStorage.renderData, renderStorage.renderDataLength);
        setSongSettingsDirty(false);
    } else {
        settingsDirty = true;
        // The loaded song contains settings but no rendered data; mark dirty so Play triggers a render.
        setSongSettingsDirty(true);
        if (loggedIn && getValueOrDefault(options, "autoRender", false)) {
            renderSong(() => {
                stopSong();
            });
        }
    }
}

function loadSong(prefix, songInfo, force) {

    function loadTheSongNow() {

        const dataFilename = prefix + "/" + songInfo.prefix + ".json";

        $.ajax(dataFilename, {
            complete: function(jqXhr, textStatus) {
                if (textStatus == "success") {
                    const response = $.parseJSON(jqXhr.responseText);
                    if (response) {
                        applyLoadedSongObject(response, {name: songInfo.name || "Song", autoRender: true});

                    }
                } else {
                    console.log("Failed to load song: " + dataFilename);
                }
            },
            type: 'GET'
        });
    }

    if (songSettingsDirty && loggedIn && !force) {
        showConfirmDialog("Load?", "Really load the song? This will overwrite the current song settings", "Yes", "No",
            () => {
                loadTheSongNow();
            },
            () => {
            });
    } else {
        loadTheSongNow();
    }
}

function loadPresetSong(songInfo, force) {
    loadSong("songpresets", songInfo, force);
}


function getUserInfo(onSuccess, onFail, onDone) {
    if (lightServerMode) {

    } else {
        $.ajax("task", {
            data: JSON.stringify({type: "getUserInfo"}),
            contentType: "application/json",
            complete: function(jqXhr, textStatus) {
                if (textStatus == "success") {
                    const response = $.parseJSON(jqXhr.responseText);
                    if (onSuccess) {
                        onSuccess(response);
                    }
                } else {
                    if (onFail) {
                        onFail(jqXhr, textStatus);
                    }
                }
                if (onDone) {
                    onDone(jqXhr, textStatus);
                }
            },
            type: "POST"
        });
    }
}

function loadMySongsList() {

    if (lightServerMode) {

    } else {
        $('#my-songs-song-list').remove();

        const urlPrefix = "users/" + userToDirName(user);
        const indexUrl = urlPrefix + "/index.json";

        const $mySongsDiv = $("#my-songs-tab");

        getUserInfo(
            response => {
                if (response && response.songs) { // onSuccess
                    createSongList(response, $mySongsDiv, urlPrefix, "my-songs", "Song", true, true, true);
                } else {
                    console.log("Did not get a valid UserInfo from server.");
                }
            },
            (jqXhr, textStatus) => { // onFail
                console.log("Did not get an answer for getUserInfo from server. Text status not success: " + textStatus);
            });
    }

}


function createLoadButton(buttonId, songInfo, $targetDiv, urlPrefix) {
    const $loadButton = $targetDiv.find("#" + buttonId);
    $loadButton.button();
    $loadButton.click(() => {
        loadSong(urlPrefix, songInfo);
    });
}
function createOverwriteButton(buttonId, songInfo, $targetDiv, urlPrefix) {
    const $owButton = $targetDiv.find("#" + buttonId);
    $owButton.button();
    $owButton.click(() => {
        overwriteSong(urlPrefix, songInfo);
    });
}
function createDeleteButton(buttonId, songInfos, songInfoIndex, $targetDiv, urlPrefix) {
    const $button = $targetDiv.find("#" + buttonId);
    $button.button();
    $button.click(() => {
        deleteSong(songInfoIndex, () => {
            loadMySongsList();
        });
    });
}
function createRenameButton(buttonId, songInfos, songInfoIndex, $targetDiv, urlPrefix) {
    const $button = $targetDiv.find("#" + buttonId);
    $button.button();
    $button.click(() => {
    });
}

function createSongList(info, $targetDiv, urlPrefix, idPrefix, namePrefix, createLoad, createDelete, createRename) {
    const songs = info.songs;
    let content = "";
    content += '<ol id="' + idPrefix + '-song-list" class="song-list" >';

    const linkStyle = "margin-right: 0.5em;";
    for (let i=0; i<songs.length; i++) {
        let songInfo = songs[i];

        let songName = songInfo.name;
        if (!songName) {
            songName = namePrefix + " " + (i + 1);
        }

        let tableContent = "<tr><td>" + songName + "</td>";

        let columns = 1;
        let columnCounter = 1;
        if (songInfo.soundfonts && songInfo.soundfonts.length > 0) {
            const defaultSfIndex = songInfo.soundfonts[0];
            const prefix = urlPrefix + "/" + songInfo.prefix;
            const midiFilename = prefix + ".mid";
            const mp3Filename = prefix + "_" + defaultSfIndex + ".mp3";
            const oggFilename = prefix + "_" + defaultSfIndex + ".ogg";

            tableContent += '<td><a style="' + linkStyle + '" href="' + midiFilename + '" >Midi</a>';
            tableContent += '<a style="' + linkStyle + '" href="' + mp3Filename + '" >Mp3</a>';
            tableContent += '<a style="' + linkStyle + '" href="' + oggFilename + '" >Ogg</a></td>';
            columnCounter += 1;
        }

        tableContent += "<td>";
        columnCounter += 1;
        if (createDelete) {
            const deleteButtonId = idPrefix + "-delete-song-button-" + i;
            tableContent += '<button id="' + deleteButtonId + '" >Delete</button>';
        }
        if (createRename) {
            const renameButtonId = idPrefix + "-rename-song-button-" + i;
            tableContent += '<button id="' + renameButtonId + '" >Rename</button>';
        }
        if (createLoad) {
            const loadButtonId = idPrefix + "-load-song-button-" + i;
            tableContent += '<button id="' + loadButtonId + '" >Load</button>';
        }
        tableContent += "</td>";

        tableContent += "</tr>";

        columns = columnCounter;
        columnCounter = 0;
//        if (songInfo.soundfonts && songInfo.soundfonts.length > 0) {
//            tableContent += "<tr>";
//            tableContent += "<td>Variants Mp3</td>";
//            columnCounter += 1;
//            tableContent += "<td>";
//            columnCounter += 1;
//            for (var j=1; j<songInfo.soundfonts.length; j++) {
//                var sfIndex = songInfo.soundfonts[j];
//                var sfName = SoundFontType.toShortString(sfIndex);
//                var mp3Filename = prefix + "_" + sfIndex + ".mp3";
//                tableContent += '<a style="' + linkStyle + '" href="' + mp3Filename + '" >' + sfName + '</a>';
//            }
//            tableContent += "</td>";
//            tableContent += "</tr>";
//
//            columns = Math.max(columns, columnCounter);
//            columnCounter = 0;
//
//            tableContent += "<tr>";
//            tableContent += "<td>Variants Ogg</td>";
//            columnCounter += 1;
//            tableContent += "<td>";
//            columnCounter += 1;
//            for (var j=1; j<songInfo.soundfonts.length; j++) {
//                var sfIndex = songInfo.soundfonts[j];
//                var sfName = SoundFontType.toShortString(sfIndex);
//                var oggFilename = prefix + "_" + sfIndex + ".ogg";
//                tableContent += '<a style="' + linkStyle + '" href="' + oggFilename + '" >' + sfName + '</a>';
//                columnCounter += 1;
//            }
//            tableContent += "</td>";
//            tableContent += "</tr>";
//            columns = Math.max(columns, columnCounter);
//        }

        content += '<table style="margin: 0px; padding: 0px; border: 0px; width: 100%" class="ui-widget-content" >';
        content += '<colgroup>';
        const colWidth = 100 / columns;
        for (let j=0; j<columns; j++) {
            content += '<col span="1" style="width: ' + Math.round(colWidth) + '%;">';
        }
        content += "</colgroup>";
        content += tableContent;
        content += "</table>";
    }
    content += "</ol>";
    const $list = $(content);
//        $list.selectable();

    $targetDiv.append($list);

    for (let i=0; i<songs.length; i++) {
        let songInfo = songs[i];
        if (createLoad) {
            let buttonId = idPrefix + "-load-song-button-" + i;
            createLoadButton(buttonId, songInfo, $targetDiv, urlPrefix);
        }
//        if (createOverwrite) {
//            var buttonId = idPrefix + "-overwrite-song-button-" + i;
//            createOverwriteButton(buttonId, songInfo, $targetDiv, urlPrefix);
//        }
        if (createDelete) {
            let buttonId = idPrefix + "-delete-song-button-" + i;
            createDeleteButton(buttonId, songs, i, $targetDiv, urlPrefix);
        }
        if (createRename) {
            let buttonId = idPrefix + "-rename-song-button-" + i;
            createRenameButton(buttonId, songs, i, $targetDiv, urlPrefix);
        }
    }
}


function createSongsPanel() {
    if (loggedIn && user) {
        $("#songtabs ul").append($('<li><a href="#my-songs-tab">My Songs</a></li>'));

        let mySongsContent = "";

        mySongsContent += '<button id="save-song-button">Save Current Song</button>';

        $("#songtabs").append($('<div id="my-songs-tab" >' + mySongsContent + '</div> '));;
    }



    $("#save-song-button").button().click(() => {
        const seed = getMainSeed();
        const name = songSettings.name;
        const genInfo = getGenInfo();
        copyWithPropertyInfoProvider(genInfo, mp3ExportSettings);

        const saveRequestData = {seed: seed, songName: name, genInfo: genInfo};

        const task = new AsyncServerChildTask({
            taskType: AsyncServerChildTaskType.SAVE_SONG,
            content: saveRequestData,
            caption: "Saving song...",
            doneCaption: "Done!",
            resultDivId: "",
            onDone: function() {
                loadMySongsList();
            },
            id: "task" + asyncOperationCounter});
        if (!addAsyncOperation(task)) {
            logit("Failed to add async op for saving song?");
        }

    });

    $("#songtabs").tabs();

    const $examplesDiv = $("#example-songs-tab");



    // Loading presets
    $.ajax("songpresets/index.json", {
//        contentType: "application/json",
        complete: function(jqXhr, textStatus) {
            if (textStatus == "success") {
                const response = $.parseJSON(jqXhr.responseText);
                if (response) {
                    createSongList(response, $examplesDiv, "songpresets", "preset", "Song Example", true, false, false);
                    const songs = response.songs;
                    if (!renderStorage.renderData && songs.length > 0) {
                        loadPresetSong(songs[0], true);
                    }
                }
//                logit(response);
            } else {
                console.log("Failed to get preset songs: " + textStatus);
            }
        },
        type: 'GET'
    });


    // Loading my songs
    if (loggedIn && user) {
        loadMySongsList();
    }

}

class UserInfo {
    constructor() {
        this.name = "";
        this.email = "";
        this.subscribe = false;
        this.acceptedTOU = false;
        this._constructorName = "UserInfo";
    }
}

function sendSimpleCommand(data) {
    $.ajax("task", {
        data: JSON.stringify(data),
        contentType: "application/json",
        complete: function(jqXhr, textStatus) {
            if (textStatus == "success") {

            } else {
                logit("Failed to send simple command:");
                logit(data);
            }
        },
        type: "POST"
    });

}

function updateUserInfo(showDialog) {
//    logit("Updating user info...");
//    logit(userInfo);

    if ($updateUserInfoButton) {
        $updateUserInfoButton.button("disable");
    }

    sendSimpleCommand({type: "updateUserInfo", name: userInfo.name, email: userInfo.email, subscribe: userInfo.subscribe, acceptedTOU: userInfo.acceptedTOU});
    if (showDialog) {
        showModalDialog("User info updated", "<p>Your personal information will only be used for support, unless you subscribe to the newsletter.</p>");
    }
}

let $updateUserInfoButton = null;

function createAccountPanel() {

    if (lightServerMode) {
        loggedIn = false;
        const userInfoComp = null;
        getUserInfo(
            response => { // onSuccess
                if (response._constructorName == "UserInfo") {
                    loggedIn = true;
                    userInfo = response;
//                logit(userInfo);
                    if (typeof(userInfo.name) == 'undefined') {
                        userInfo.name = "";
                    }
                    if (typeof(userInfo.email) == 'undefined') {
                        userInfo.email = "";
                    }
                    if (typeof(userInfo.subscribe) == 'undefined') {
                        userInfo.subscribe = false;
                    }
                    if (typeof(userInfo.acceptedTOU) == 'undefined') {
                        userInfo.acceptedTOU = false;
                    }
                    function showTOUWhenLoaded() {
                        if (allLoaded) {
                            showAcceptTermsOfUseIfNecessary();
                        } else {
                            setTimeout(showTOUWhenLoaded, 100);
                        }
                    }
                    showTOUWhenLoaded();
                } else {
                    console.log(response);
                }
            },
            (jqXhr, textStatus) => { // onFail
                console.log("Failed to get user info in account panel " + textStatus);
            },
            () => { // onDone
                let html = "<p></p>";
                if (loggedIn) {
                    html =
                        '<form action="logout" method="get" id="logout_form">' +
                            '<fieldset>' +
                            '<div id="logout_input_area">' +
                            '<input id="openid_submit" type="submit" value="Log Out"/>' +
                            '</div>' +
                            '</fieldset>' +
                            '</form>';

                    let userInfoComp = new GuiPropertiesComponent({object: userInfo, propertyInfoProvider: propertyInfoProvider});
                    userInfoComp.changeListeners.push(() => {
                        if ($updateUserInfoButton) {
                            $updateUserInfoButton.button("enable");
                        }
                    });

                    const contentArr = [];
                    userInfoComp.createJQueryStrings(contentArr);
                    html += contentArr.join("");

                    html += '<button id="updateUserInfoButton" >Submit personal info</button>';

                } else {
                    html =
                        '<form action="auth" method="get" id="openid_form">' +
                            '<input type="hidden" name="action" value="verify" />' +
                            '<fieldset>' +
                            '<legend>Sign-in or Create New Account</legend>' +
                            '<div id="openid_choice">' +
                            '<p>Please click your account provider:</p>' +
                            '<div id="openid_btns"></div>' +
                            '</div>' +
                            '<div id="openid_input_area">' +
                            '<input id="openid_identifier" name="openid_identifier" type="text" value="http://" />' +
                            '<input id="openid_submit" type="submit" value="Sign-In"/>' +
                            '</div>' +
                            '<noscript>' +
                            '<p>OpenID is service that allows you to log-on to many different websites using a single identity.' +
                            'Find out <a href="http://openid.net/what/">more about OpenID</a> and <a href="http://openid.net/get/">how to get an OpenID enabled account</a>.</p>' +
                            '</noscript>' +
                            '</fieldset>' +
                            '</form>';
                }

                html += '<p><button id="touButton" >Terms of use</button></p>';

                const $html = $(html);


                const $div = $("#accountDialogDiv");
                $div.append($html);

                $updateUserInfoButton = $("#updateUserInfoButton");
                $updateUserInfoButton.button().click(() => {
                    updateUserInfo(true);
                });
                $updateUserInfoButton.button("disable");

                const $touButton = $("#touButton");
                $touButton.button().click(() => {
                    showTermsOfUse();
                });

                openid.init('openid_identifier');

                $div.find("#openid_submit").button();
                //    openid.setDemoMode(true);

                if (userInfoComp) {
                    userInfoComp.jQueryCreated($div);
                    userInfoComp.alignComponents();
                }

            }
        );

    }

}

function createPlayerPanel() {

    const $playerDialog = $("#playerDialogDiv");

    if (AudioPlayerConstructor) {
        const prefixes = ["wa"];

        const playerButtons = ["rewind", "play", "stop", "forward"];
        const playerButtonIcons = ["seek-prev", "play", "stop", "seek-next"];

        for (const prefix of prefixes) {
            for (let i=0; i<playerButtons.length; i++) {
                const $button = $("#" + prefix + playerButtons[i] + "button");

                const icon = playerButtonIcons[i];
                $button.button({
                    "text": false,
                    "icons": {
                        primary: "ui-icon-" + icon
                    }
                });
            }
        }


        const $webAudioPlayerDiv = $("#waPlayerDiv");

        const tabCaptions = [AudioPlayerConstructor.prototype.title];
        const tabObjects = [webAudioPlayerSettings];

        const tabObjectPresets = null; // [visualizer3DSettingsPresets];

        const result = SongSettingsComponent.createTabs($playerDialog, "playerSettingsTab", "player-settings-panel", tabCaptions, tabObjects,
            (comp, oldValue, newValue) => {
                settingsDirty = true;
            }, tabObjectPresets);

        $webAudioPlayerDiv.detach();
        $("#playerSettingsTab0").prepend($webAudioPlayerDiv);

        return result;
    } else {
        $playerDialog.remove();
        return null;
    }
}


function createVisualizerSettingsPanel() {
    const tabCaptions = ["Visualizer", "Interface"];
    const tabObjects = [visualizer3DSettings, themeSettings];
    const tabObjectPresets = null; // [visualizer3DSettingsPresets, themeSettingsPresets];

    const id = "visualizerSettingsTab";
    const cls = "visualizer-settings-panel";
    SongSettingsComponent.createTabs($("#visualizerSettingsDialogDiv"), id, cls, tabCaptions, tabObjects,
        (comp, oldValue, newValue) => {
            settingsDirty = true;
        }, tabObjectPresets);

}


function createSongSettingsPanel() {
    const $songSettingsDialog = $("#songSettingsDialogDiv");
    const tabCaptions = ["Song", "Structure Seeds", "Content Seeds", "Indices Seeds", "Parameters", "Domains", "Details"];
    const tabObjects = [songSettings, songStructureSeedSettings, songContentSeedSettings, songIndicesSeedSettings, songParameters, songDomains, songDetails];
    const tabObjectPresets = [songSettingsPresets, songStructureSeedSettingsPresets, songContentSeedSettingsPresets, songIndicesSeedSettingsPresets, songParametersPresets, songDomainsPresets, songDetailsPresets];
    const createSeeds = [false, true, true, true, false, false, false];
    const tabsId = "songSettingsTab";
    return SongSettingsComponent.createTabs($songSettingsDialog, tabsId, "settings-panel", tabCaptions, tabObjects,
        (comp, oldValue, newValue) => {
            settingsDirty = true;
            setSongSettingsDirty(true);
            if (getFirstRunningServerTaskWithType(AsyncServerChildTaskType.RENDER)) {
                songSettingsChangedWhileRendering = true;
            }
        }, tabObjectPresets, createSeeds);
}



function updateGuiFromEditorSettings(dialogs) {
    // Hide the dialogs that should be hidden :)
    for (const dialog of dialogs) {
        const $dialog = $("#" + dialog + "DialogDiv");
        const pos = editorSettings[dialog + "Position"];
        if (pos) {
            $dialog.dialog("option", "position", {my: "left top", at: "left+" + pos[0] + " top+" + pos[1]});
//            console.log("left : " + left);
        } else {
            logit("Could not find pos for " + dialog);
        }
        const visible = !!editorSettings[dialog + "Visible"];
        if (!visible) {
            $dialog.dialog("close");
        }
    }
}


function createDialogAndToggle(dialog, caption, width, at) {

    const $buttonsDiv = $("#buttonsDiv");

    $buttonsDiv.append($('<input type="checkbox" checked="checked" id="' + dialog + 'DialogShow"/><label class="toggle-button" for="' + dialog + 'DialogShow">' + caption + '</label>'));

    const $toggle = $("#" + dialog + "DialogShow");
    const $dialog = $("#" + dialog + "DialogDiv");

    $dialog.dialog({
//        dialogClass: "transparent",
        closeText: "hide",
        width: width,
        resizable: false,
        show: {effect: "fade", duration: "fast"},

        create: function(event, ui) {
            const widget = $(this).dialog("widget");
            $(".ui-dialog-titlebar-close span", widget)
                .removeClass("ui-icon-closethick")
                .addClass("ui-icon-minusthick");
        },
        dragStop: function(event, ui) {
            editorSettings[dialog + "Position"] = [ui.position.left, ui.position.top];
            settingsDirty = true;
            editorSettings.dirty = true;
//            logit(JSON.stringify(ui));
//            if (pos) {
//                $dialog.dialog("option", "position", {my: "left top", at: "left+" + pos[0] + " top+" + pos[1]});
//            }
//                logit("hej");
        }
//        hide: {effect: "fade", duration: 20}
    });


    $dialog.dialog("option", "position", {my: "center", at: at});

//    $dialog.on("dragstop", function(event, ui) {logit("hej")});


    const $dialogWidget = $dialog.dialog("widget");
    if (themeSettings.transparentDialogs) {
        $dialogWidget.addClass("transparent");
        $dialog.addClass("very-transparent");
    }

    function makeFullyVisible() {
        if (visualizer && !visualizer.mouseCanvasDown) {
            $dialogWidget.removeClass("transparent");
            $dialog.removeClass("very-transparent");
            $dialog.removeClass("transparent");
        }
    }

    $dialogWidget.on("mousedown", () => {
        makeFullyVisible();
        $dialog.dialog("moveToTop");
        $dialog.data("dragging", true);
    });

    $dialogWidget.on("mouseup", () => {
        makeFullyVisible();
        $dialog.data("dragging", false);
    });

    $dialogWidget.on("mouseenter", () => {
        if (visualizer && !visualizer.mouseCanvasDown) {
            makeFullyVisible();
//            $dialog.removeClass("very-transparent");
        }
    });
    $dialogWidget.on("mouseleave", () => {
        if (themeSettings.transparentDialogs && !$dialog.data("dragging")) {
            $dialogWidget.addClass("transparent");
            $dialog.addClass("very-transparent");
            $dialog.removeClass("transparent");
        }
    });

    $dialog.on("dialogclose", () => {
//            console.log("Closing...");
        $toggle[0].checked = false;
        $toggle.button("refresh");
        editorSettings[dialog + "Visible"] = false;
        editorSettings.dirty = true;
        settingsDirty = true;
//        $dialogWidget.addClass("transparent");
//        logit("Closing " + dialog);
    });
//    $dialogsDiv.css("opacity", "0.5");
//    $dialog.css("opacity", "0.5");

    $dialog.css("max-height", "35em");
//    $dialog.css("opacity", "0.5");
//        $dialog.css("min-height", "500px");
//        $dialog.dialog("option", "maxHeight", 500);
//        $dialog.dialog("option", "minHeight", 400);
    $dialog.on("dialogopen", () => {
//                   console.log("Opening...");
        editorSettings[dialog + "Visible"] = true;
        editorSettings.dirty = true;
        settingsDirty = true;
//        logit("Opening " + dialog);
    });
    $toggle.button().on("change", function() {
        const dialogOpen = $dialog.dialog("isOpen");
        if (this.checked && !dialogOpen) {
            $dialog.dialog("open");
        } else if (!this.checked && dialogOpen) {
            $dialog.dialog("close");
        }
    });
}

function stopSong() {
    if (audioPlayer) {
        audioPlayer.stop();
    }
    visualizer.clearHighlightNotes();
    visualizer.setMode(VisualizerMode.STOP);
    if (audioPlayer) {
        visualizer.setCurrentPlayBeatTime(audioPlayer.songPlayBeatTime);
    }
    $playButton.button( "option", "icons", {primary: "ui-icon-play"});
}

//function foo() {
//    logit("Logged in cookie: " + $.cookie('loggedin'));
//}

const termsOfUseContent = [
    '<p>',
    '<ul>',
    '<li>All songs that are generated through this site (abundant-music.com) are public domain by default. Users do not get copyright of any generated song' +
        ', but since the songs are public domain, they can be used commercially.</li>',
    '<li>The user is responsible that the generated songs or their use do not infringe any other copyrights. ' +
        'In such cases, the generated songs are not public domain.</li>',
    '<li>It is not allowed to use this site as an API. It is only allowed to use through abundant-music.com\'s graphical user interface. ' +
        'It is not allowed to use the site in parallel from several computers with same login.</li>',
    '<li>The site uses cookies, which are small files stored on the user\'s computer. ' +
        'The cookies on the site are only used to determine whether users are logged in or not.</li>',
//            '<li></li>',
    '</ul>',
    '<p>',
    '<p>Note that these terms of use may change.</p>'];

function showTermsOfUse() {
    showModalDialog("Terms of Use", termsOfUseContent.join(""),
        {
            resizable: false,
            draggable: false,
            width: '40em',
            modal: true,
            closeOnEscape: false,
            buttons: {
                "OK": function() {
                    $(this).dialog("close");
                }
            }
        });
}

function showAcceptTermsOfUseIfNecessary() {
    // Show the terms of use if not accepted
    if (userInfo && !userInfo.acceptedTOU) {
        showModalDialog("Terms of Use", termsOfUseContent.join(""),
            {
                resizable: false,
                draggable: false,
                beforeClose: function() {
                    if (!userInfo.acceptedTOU) {
                        return false;
                    }
                },
                width: '40em',
                modal: true,
                closeOnEscape: false,
                buttons: {
                    "I Accept": function() {
                        userInfo.acceptedTOU = true;
                        updateUserInfo(false);
                        $(this).dialog("close");
                    },
                    "Logout": function() {
                        window.location.href = "logout";
                    }
                }
            });
    }
}

function updateRenderStorageAndVisualizer(op) {
    renderStorage.channelMaps = op.resultChannelMaps;
    renderStorage.channelMaps = op.resultChannelMaps;
    renderStorage.renderData = op.resultRenderData;
    renderStorage.sectionTimes = op.resultSectionTimes;
    renderStorage.songStructureInfo = op.resultSongStructureInfo;
    renderStorage.renderDataLength = Math.max(1, op.resultRenderDataLength);
    renderStorage.dirty = true;
    settingsDirty = true;

    tempTempoEvents = copyValueDeep(gatherEventsWithType(renderStorage.renderData.events, "t"));
    visualizer.resetRenderData();
    visualizer.addRenderData(renderStorage.renderData, renderStorage.renderDataLength);

    visualizer.setSectionInfos(op.resultSectionTimes, op.resultSongStructureInfo);

    updateSongInfoPanel();

    if (!songSettingsChangedWhileRendering) {
        setSongSettingsDirty(false);
    }
}


function renderSong(doneFunc, cancelFunc, failFunc) {

    if (lightServerMode && !window.Worker) {
        showModalDialog("Not Supported",
            "The server doesn't support this operation and you need a browser with WebWorker support to do this in the client.");
    } else {

        songSettingsChangedWhileRendering = false;

        const seed = getMainSeed();
        const renderRequestData = {seed: seed, sectionIndex: -1, genInfo: getGenInfo()};

//    logit("Rendeirng with seed " + seed);

        const params = {
            taskType: WorkerTaskType.RENDER,
            content: renderRequestData,
            caption: "Composing song...",
            doneCaption: "Done!",
            onSuccess: function(op) {

//            logit("Rendered song success!");
                updateRenderStorageAndVisualizer(op);
                if (doneFunc) {
                    doneFunc();
                }
            },
            onCancel: function(op) {
                if (cancelFunc) {
                    cancelFunc();
                }
            },
            onFail: function(op) {
                if (failFunc) {
                    failFunc();
                }
            },
            id: "task" + asyncOperationCounter};

        let task = null;
        if (window.Worker) {
            task = new AsyncWorkerTask(params);
        } else {
            if (lightServerMode) {
                showModalDialog("No Web Worker Support Detected",
                    "This browser doesn't support web workers, which is necessary when Abundant Music runs on a lightweight server");
            } else {
                params.taskType = AsyncServerChildTaskType.RENDER;
                task = new AsyncServerChildTask(params);
            }
        }

        if (!addAsyncOperation(task)) {
            if (failFunc) {
                failFunc();
            }
        }
    }
}

let first = true;
function setVisualizerSize() {
    let w = window.innerWidth;
    let h = window.innerHeight;

    if (!w || !h) {
        const $document = $(document);
        w = $document.innerWidth();
        h = $document.innerWidth();
    }
    if (first) {
        const $body = $("body");
        const scaler = clamp(Math.min(w, h) / 1000, 0.5, 2);
        const fontSize = 16 * scaler;
        $body.css("font-size", fontSize + "px");
        first = false;
    }

    visualizer.resized(w, h);
}

function sendFeedback() {

    const feedbackStr = $("#feedbackTextArea").val();

    if (feedbackStr) {
        sendSimpleCommand({type: "giveFeedback", feedback: feedbackStr});
        showModalDialog("Feedback sent", "<p>Thanks a lot!</p>");
    } else {
        showModalDialog("Feedback info", "<p>Feedback text empty?</p>");
    }
}


function composeSetup1() {

    // Check if we are logged in
    loggedIn = $.cookie('loggedin') == "true";
    user = decodeURIComponent($.cookie('loggedinuser'));

//    logit("user dir name: " + userToDirName(user) + " from " + user);

    const $window = $(window);
    const $canvasfor2dcontext = $("#canvasfor2dcontext");

    const canvasfor2dcontext = $canvasfor2dcontext[0];

    const startTime = Date.now();

    if (Modernizr.webgl && !visualizer3DSettings.forceContext2D) {
//        visualizer = new CanvasVisualizer3D(canvasfor2dcontext, startTime);
        const webGLOptions = {
            addBloom: visualizer3DSettings.addBloom,
            addSimulatedAA: visualizer3DSettings.addSimulatedAA,
            addVignette: visualizer3DSettings.addVignette
        };
        try {
            visualizer = new WebGLVisualizer3D(canvasfor2dcontext, webGLOptions);
            usingWebGL = true;
        } catch (exc) {
            console.log(exc);
            console.log("Error when initializing webgl. Using 2D context.");
            visualizer = new CanvasVisualizer3D(canvasfor2dcontext, startTime);
            visualizer3DSettings.forceContext2D = true;
        }
    } else {
        visualizer = new CanvasVisualizer3D(canvasfor2dcontext, startTime);
    }
//    visualizer.render();


    $window.on("resize", () => {
        setVisualizerSize();
        visualizer.render();
    });

    setVisualizerSize();

    setTimeout(composeSetup2, loaderTimeout);

    updateLoaderProgress(70);
}

function composeSetup2() {
    songSettingsCompInfo = createSongSettingsPanel();
    createSongImportToolsPanel();
    setTimeout(composeSetup3, loaderTimeout);
    updateLoaderProgress(80);
}

function composeSetup3() {

    createVisualizerSettingsPanel();
    createExportPanel();
    createSongInfoPanel();
    createPlayerPanel();
    createAccountPanel();

    $("#helpTabs").tabs();

    createSongsPanel();

    setTimeout(composeSetup4, loaderTimeout);

    updateLoaderProgress(90);
}


function composeSetup4() {
    const $feedbackDialogDiv = $("#feedbackDialogDiv");
    if (!loggedIn) {
        $feedbackDialogDiv.empty();
        $feedbackDialogDiv.append("Log in to enable feedback. Thanks!");
    } else {
        $feedbackDialogDiv.find("#submitFeedbackButton").button().click(() => {
            sendFeedback();
            $feedbackDialogDiv.find("#feedbackTextArea").val("");
        });
    }

    const dialogs = ["songSettings", "songInfo", "player", "visualizerSettings", "songs", "export", "help", "feedback", "account"];
    const captions = ["Song Settings" , "Song Info", "Player", "Visual Settings", "Songs", "Export", "Help/Credits", "Feedback", "Account"];
    const widths = ["60em", "60em", Modernizr.webaudio ? "45em" : null, "45em", "45em", "45em", "50em", lightServerMode ? null : "45em", lightServerMode ? null : "40em"];
    const ats = ["right", "right top", "right", "top", "top", "top", "left", "left", "left"];

    for (let i=0; i<dialogs.length; i++) {

        const dialog = dialogs[i];
        const width = widths[i];
        const caption = captions[i];
        if (width) {
            createDialogAndToggle(dialog, caption, width, ats[i]);
        } else {
            // Remove toggle
            const $dialog = $("#" + dialog + "DialogDiv");
            $dialog.remove();
        }
    }

    // Always-visible transport controls (mirrors the Player dialog buttons)
    const $buttonsDiv = $("#buttonsDiv");
    const $transport = $(
        '<span id="transportButtons" style="margin-left: 1em;">' +
        '  <button id="transportRewindButton" title="Rewind">Rewind</button>' +
        '  <button id="transportPlayButton" title="Play/Pause" style="margin-left: 0.2em;">Play</button>' +
        '  <button id="transportStopButton" title="Stop" style="margin-left: 0.2em;">Stop</button>' +
        '  <button id="transportForwardButton" title="Forward" style="margin-left: 0.2em;">Forward</button>' +
        '</span>'
    );
    $buttonsDiv.append($transport);

    $("#transportRewindButton").button({ text: false, icons: { primary: "ui-icon-seek-prev" } }).click(() => {
        $("#warewindbutton").click();
    });
    $("#transportPlayButton").button({ text: false, icons: { primary: "ui-icon-play" } }).click(() => {
        $("#waplaybutton").click();
    });
    $("#transportStopButton").button({ text: false, icons: { primary: "ui-icon-stop" } }).click(() => {
        $("#wastopbutton").click();
    });
    $("#transportForwardButton").button({ text: false, icons: { primary: "ui-icon-seek-next" } }).click(() => {
        $("#waforwardbutton").click();
    });

    $refreshButton = $('<button style="margin-left: 1em;">Compose</button>');
    $buttonsDiv.append($refreshButton);
    $refreshButton.button({
            icons: {
                primary: "ui-icon-locked"
            }
        }
    );
    $refreshButton.click(() => {
        if (songSettingsDirty) {
            $refreshButton.button("option", "disabled", true);
            renderSong(
                () => { // On done
                },
                () => { // On cancel
                    $refreshButton.button("option", "disabled", false);
                },
                () => { // On fail
                    $refreshButton.button("option", "disabled", false);
                }
            );
        }
    });

    // Updating GUI from settings
    updateGuiFromEditorSettings(dialogs);

    $playButton = $("#waplaybutton");
    $stopButton = $("#wastopbutton");
    $forwardButton = $("#waforwardbutton");
    $rewindButton = $("#warewindbutton");

    let audioStepTime = 10;

    function playerUpdate() {
        let updateMillis = 500;
        if (audioPlayer) {
            const before = Date.now();
            audioPlayer.step();
            const after = Date.now();

            const diff = after - before;

            audioStepTime = 0.95 * audioStepTime + 0.05 * diff;

//            logit(" audio step time " + audioStepTime + " latest: " + diff);
//            logit("player beat time: " + webAudioPlayer.songPlayBeatTime);

            if (audioPlayer.mode == AudioPlayerMode.PLAY) {
                visualizer.setCurrentPlayBeatTime(audioPlayer.songPlayBeatTime);
                updateMillis = 100;
            }
        }
//        logit("Update millis " + updateMillis);
        setTimeout(playerUpdate, updateMillis);
    }

    function playSong() {
        if (audioPlayer == null) {
            audioPlayer = new AudioPlayerConstructor();
        }

        $latestAudioElement = null; // Cancels the other player

        audioPlayer.soundFontType = webAudioPlayerSettings.soundFontType;

        audioPlayer.settings = webAudioPlayerSettings;

        audioPlayer.setRenderData(renderStorage.renderData);

        audioPlayer.setChannelMaps(renderStorage.channelMaps);

        function doPlay() {
            audioPlayer.play();
            visualizer.setMode(VisualizerMode.PLAY);
            visualizer.setCurrentPlayBeatTime(audioPlayer.songPlayBeatTime);
            $playButton.button( "option", "icons", {primary: "ui-icon-pause"});
        }
        audioPlayer.getReadyForPlay(
            () => {
                $playButton.button("option", "disabled", false);
                doPlay();
            },
            () => { // cancel
                $playButton.button("option", "disabled", false);
            }
        );
    }

    function pauseSong() {
        audioPlayer.pause();
        visualizer.setMode(VisualizerMode.PAUSE);
        $playButton.button( "option", "icons", {primary: "ui-icon-play"});
    }

    function stepForward() {
        if (audioPlayer) {
            audioPlayer.gotoBeat(audioPlayer.songPlayBeatTime + 8);
            visualizer.clearHighlightNotes();
            visualizer.setCurrentPlayBeatTime(audioPlayer.songPlayBeatTime);
        }
    }
    function rewind() {
        if (audioPlayer) {
            audioPlayer.gotoBeat(audioPlayer.songPlayBeatTime - 8);
            visualizer.clearHighlightNotes();
            visualizer.setCurrentPlayBeatTime(audioPlayer.songPlayBeatTime);
        }
    }


    $playButton.click(() => {
        if (audioPlayer && audioPlayer.mode == AudioPlayerMode.PLAY) {
            pauseSong();
        } else {
            $playButton.button("option", "disabled", true);
            if (songSettingsDirty) {
                renderSong(
                    () => { // On done
                        playSong();
                    },
                    () => { // On cancel
                        $playButton.button("option", "disabled", false);
                    },
                    () => { // On fail
                        logit("kljd");
                        $playButton.button("option", "disabled", false);
                    }
                );
            } else {
                $playButton.button("option", "disabled", true);
                playSong();
            }
        }
    });

    $stopButton.click(() => {
        stopSong();
    });

    $forwardButton.click(() => {
        stepForward();
    });

    $rewindButton.click(() => {
        rewind();
    });

    function checkSettingsChange() {
        if (settingsDirty) {
            saveSettingsToLocalStorage();
            settingsDirty = false;
            logit("Saving settings");
        }
        setTimeout(checkSettingsChange, 500);
    }
    checkSettingsChange();

    let prevVisualizerTime = Date.now();

    let stepCounter = 0;

    function animate() {
        requestAnimationFrame(animate);

//        logit("dhskf " + stepCounter);
        let paintFps = visualizer3DSettings.context2DFps;
        if (usingWebGL) {
            paintFps = visualizer3DSettings.webGLFps;
        }
        if (visualizer3DSettings.usePerspective) {
            if (!visualizer.camera.inPerspectiveMode) {
                visualizer.camera.toPerspective();
            }
        } else {
            if (!visualizer.camera.inOrthographicMode) {
                visualizer.camera.toOrthographic();
            }
        }

        const paintModulus = clamp(Math.round(60 / paintFps), 1, 60);
        const time = Date.now();
        const dt = time - prevVisualizerTime;
        visualizer.stopMovementMode = visualizer3DSettings.stopMovementMode;
        visualizer.step(dt);
        stepCounter++;
        if ((stepCounter % paintModulus) == 0) {
            if (visualizer3DSettings.on) {
                visualizer.render();
            }
        }
        prevVisualizerTime = time;
    }

    animate();
    playerUpdate();


    if (renderStorage.renderData) {
        setSongSettingsDirty(false);
        visualizer.addRenderData(renderStorage.renderData, renderStorage.renderDataLength);
    }
    if (renderStorage.songStructureInfo && renderStorage.sectionTimes) {
        visualizer.setSectionInfos(renderStorage.sectionTimes, renderStorage.songStructureInfo);
    }

    updateSongInfoPanel();


    // All is loaded now. We can stop hiding :)
    $("#hider-div").remove();

    allLoaded = true;
}