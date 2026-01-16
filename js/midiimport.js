// Client-side Standard MIDI File (SMF) import + basic analysis for creating Abundant Music presets.
// Keeps output compatible with the existing codebase (GenInfo + updateSongSettingsComponent).

const MidiImport = (() => {

    class ByteReader {
        constructor(arrayBuffer) {
            this.dv = new DataView(arrayBuffer);
            this.pos = 0;
            this.len = arrayBuffer.byteLength;
        }
        remaining() {
            return this.len - this.pos;
        }
        seek(newPos) {
            this.pos = newPos;
        }
        skip(n) {
            this.pos += n;
        }
        readU8() {
            const v = this.dv.getUint8(this.pos);
            this.pos += 1;
            return v;
        }
        readS8() {
            const v = this.dv.getInt8(this.pos);
            this.pos += 1;
            return v;
        }
        readU16BE() {
            const v = this.dv.getUint16(this.pos, false);
            this.pos += 2;
            return v;
        }
        readU32BE() {
            const v = this.dv.getUint32(this.pos, false);
            this.pos += 4;
            return v;
        }
        readBytes(count) {
            const start = this.pos;
            const end = this.pos + count;
            if (end > this.len) {
                throw new Error("Unexpected EOF");
            }
            this.pos = end;
            const arr = new Uint8Array(this.dv.buffer, start, count);
            // Return a copy to avoid aliasing the backing buffer.
            return new Uint8Array(arr);
        }
        readAscii(count) {
            const bytes = this.readBytes(count);
            let s = "";
            for (let i = 0; i < bytes.length; i++) {
                s += String.fromCharCode(bytes[i]);
            }
            return s;
        }
        readVarLen() {
            // Standard variable-length quantity (VLQ)
            let value = 0;
            for (let i = 0; i < 4; i++) {
                const b = this.readU8();
                value = (value << 7) | (b & 0x7F);
                if ((b & 0x80) === 0) {
                    return value;
                }
            }
            return value;
        }
    }

    function assertTag(actual, expected) {
        if (actual !== expected) {
            throw new Error("Invalid MIDI file tag. Expected '" + expected + "' but got '" + actual + "'");
        }
    }

    function parseTrack(reader, trackEndPos) {
        const events = [];
        let runningStatus = null;
        let absTick = 0;

        while (reader.pos < trackEndPos) {
            const delta = reader.readVarLen();
            absTick += delta;

            let statusOrData = reader.readU8();
            let status = statusOrData;
            let data1 = null;

            if (statusOrData < 0x80) {
                // Running status
                if (runningStatus == null) {
                    throw new Error("Running status encountered without prior status byte");
                }
                status = runningStatus;
                data1 = statusOrData;
            } else {
                runningStatus = statusOrData;
            }

            if (status === 0xFF) {
                // Meta event
                const metaType = reader.readU8();
                const len = reader.readVarLen();
                const data = reader.readBytes(len);

                if (metaType === 0x2F) {
                    // End of track
                    events.push({ absTick: absTick, eventMessage: { messageClass: "EndTrackMessage" } });
                    break;
                }

                if (metaType === 0x51 && data.length === 3) {
                    const microsPerQuarter = (data[0] << 16) | (data[1] << 8) | data[2];
                    events.push({
                        absTick: absTick,
                        eventMessage: {
                            messageClass: "SetTempoMessage",
                            microsPerQuarter: microsPerQuarter
                        }
                    });
                } else if (metaType === 0x58 && data.length >= 2) {
                    const numerator = data[0];
                    const denomPow = data[1];
                    const denominator = Math.pow(2, denomPow);
                    events.push({
                        absTick: absTick,
                        eventMessage: {
                            messageClass: "TimeSignatureMessage",
                            numerator: numerator,
                            denominator: denominator
                        }
                    });
                } else if (metaType === 0x59 && data.length >= 2) {
                    // data[0] is signed number of sharps/flats
                    const sf = (data[0] & 0x80) ? data[0] - 256 : data[0];
                    const mi = data[1]; // 0 major, 1 minor
                    events.push({
                        absTick: absTick,
                        eventMessage: {
                            messageClass: "KeySignatureMessage",
                            sf: sf,
                            mi: mi
                        }
                    });
                }

                continue;
            }

            if (status === 0xF0 || status === 0xF7) {
                // SysEx event: skip payload
                const len = reader.readVarLen();
                reader.skip(len);
                continue;
            }

            const statusHi = status & 0xF0;
            const channel = status & 0x0F;

            const hasOneDataByte = (statusHi === 0xC0 || statusHi === 0xD0);
            if (data1 == null) {
                data1 = reader.readU8();
            }
            const data2 = hasOneDataByte ? null : reader.readU8();

            if (statusHi === 0x90) {
                // Note on; velocity 0 is note off
                const vel = data2 == null ? 0 : data2;
                const isOff = vel === 0;
                events.push({
                    absTick: absTick,
                    eventMessage: {
                        messageClass: "VoiceMessage",
                        status: isOff ? "NOTE_OFF" : "NOTE_ON",
                        channel: channel,
                        data1: data1,
                        data2: isOff ? 0 : vel
                    }
                });
            } else if (statusHi === 0x80) {
                events.push({
                    absTick: absTick,
                    eventMessage: {
                        messageClass: "VoiceMessage",
                        status: "NOTE_OFF",
                        channel: channel,
                        data1: data1,
                        data2: data2 == null ? 0 : data2
                    }
                });
            } else if (statusHi === 0xC0) {
                events.push({
                    absTick: absTick,
                    eventMessage: {
                        messageClass: "ProgramChangeMessage",
                        channel: channel,
                        program: data1
                    }
                });
            } else if (statusHi === 0xB0) {
                // Control change
                events.push({
                    absTick: absTick,
                    eventMessage: {
                        messageClass: "ChannelMessage",
                        status: "CONTROL_CHANGE",
                        channel: channel,
                        data1: data1,
                        data2: data2 == null ? 0 : data2
                    }
                });
            } else {
                // Ignore other channel messages for now
            }
        }

        return events;
    }

    function mergeTracksToSingleTrackEvents(parsedTracks) {
        const merged = [];
        for (const track of parsedTracks) {
            for (const e of track) {
                if (!e || typeof e.absTick === 'undefined' || !e.eventMessage) {
                    continue;
                }
                merged.push(e);
            }
        }

        merged.sort((a, b) => {
            if (a.absTick !== b.absTick) {
                return a.absTick - b.absTick;
            }
            // Stable-ish: tempo/time-sig/key before note events at same tick
            const aCls = a.eventMessage.messageClass || "";
            const bCls = b.eventMessage.messageClass || "";
            const prio = {
                "SetTempoMessage": 1,
                "TimeSignatureMessage": 2,
                "KeySignatureMessage": 3,
                "ProgramChangeMessage": 4,
                "VoiceMessage": 5,
                "ChannelMessage": 6,
                "EndTrackMessage": 99
            };
            return (prio[aCls] || 50) - (prio[bCls] || 50);
        });

        // Convert to delta times
        let lastAbs = 0;
        const trackEvents = [];
        for (const e of merged) {
            const delta = e.absTick - lastAbs;
            lastAbs = e.absTick;
            trackEvents.push({
                eventTime: delta,
                eventMessage: e.eventMessage
            });
        }
        return trackEvents;
    }

    function parseSmf(arrayBuffer) {
        const reader = new ByteReader(arrayBuffer);

        const headerTag = reader.readAscii(4);
        assertTag(headerTag, "MThd");

        const headerLen = reader.readU32BE();
        if (headerLen < 6) {
            throw new Error("Invalid MThd length: " + headerLen);
        }

        const format = reader.readU16BE();
        const numTracks = reader.readU16BE();
        const division = reader.readU16BE();

        if (headerLen > 6) {
            reader.skip(headerLen - 6);
        }

        if (division & 0x8000) {
            throw new Error("SMPTE time divisions are not supported");
        }

        const parsedTracks = [];
        for (let i = 0; i < numTracks; i++) {
            const trackTag = reader.readAscii(4);
            assertTag(trackTag, "MTrk");
            const trackLen = reader.readU32BE();
            const trackEndPos = reader.pos + trackLen;
            parsedTracks.push(parseTrack(reader, trackEndPos));
            reader.seek(trackEndPos);
        }

        const midiData = {
            fileFormat: 0,
            midiDivisions: division,
            midiTracks: [
                {
                    trackEvents: mergeTracksToSingleTrackEvents(parsedTracks)
                }
            ]
        };

        return {
            midiData: midiData,
            mergedEvents: midiData.midiTracks[0].trackEvents
        };
    }

    function analyzeMergedEvents(mergedDeltaEvents, options) {
        options = options || {};
        const midiDivisions = getValueOrDefault(options, "midiDivisions", 192);

        let absTick = 0;
        const tempoEvents = [];
        const timeSigEvents = [];
        const keySigEvents = [];

        const programByChannel = {};
        const programCounts = {};

        // Notes reconstructed from NOTE_ON/OFF
        const active = {};
        const notes = [];
        const channelNoteOnCounts = {};
        const channelNotePitchSum = {};
        const channelNotePitchCount = {};

        function ensureActiveChan(ch) {
            if (!active[ch]) {
                active[ch] = {};
            }
            return active[ch];
        }
        function pushActive(ch, pitch, startTick, velocity) {
            const chan = ensureActiveChan(ch);
            if (!chan[pitch]) {
                chan[pitch] = [];
            }
            chan[pitch].push({ startTick: startTick, velocity: velocity });
        }
        function popActive(ch, pitch) {
            const chan = ensureActiveChan(ch);
            const stack = chan[pitch];
            if (!stack || stack.length === 0) {
                return null;
            }
            return stack.pop();
        }

        for (const e of mergedDeltaEvents) {
            absTick += (e.eventTime || 0);
            const msg = e.eventMessage;
            if (!msg) {
                continue;
            }

            switch (msg.messageClass) {
                case "SetTempoMessage":
                    tempoEvents.push({ absTick: absTick, microsPerQuarter: msg.microsPerQuarter });
                    break;
                case "TimeSignatureMessage":
                    timeSigEvents.push({ absTick: absTick, numerator: msg.numerator, denominator: msg.denominator });
                    break;
                case "KeySignatureMessage":
                    keySigEvents.push({ absTick: absTick, sf: msg.sf, mi: msg.mi });
                    break;
                case "ProgramChangeMessage":
                    programByChannel[msg.channel] = msg.program;
                    programCounts[msg.program] = (programCounts[msg.program] || 0) + 1;
                    break;
                case "VoiceMessage": {
                    const ch = msg.channel;
                    const pitch = msg.data1;
                    const vel = msg.data2 || 0;
                    const isOn = msg.status === "NOTE_ON" && vel > 0;
                    const isOff = msg.status === "NOTE_OFF" || (msg.status === "NOTE_ON" && vel === 0);
                    if (isOn) {
                        pushActive(ch, pitch, absTick, vel);
                        channelNoteOnCounts[ch] = (channelNoteOnCounts[ch] || 0) + 1;
                        channelNotePitchSum[ch] = (channelNotePitchSum[ch] || 0) + pitch;
                        channelNotePitchCount[ch] = (channelNotePitchCount[ch] || 0) + 1;
                    } else if (isOff) {
                        const start = popActive(ch, pitch);
                        if (start) {
                            const endTick = absTick;
                            if (endTick > start.startTick) {
                                notes.push({
                                    channel: ch,
                                    pitch: pitch,
                                    startTick: start.startTick,
                                    endTick: endTick,
                                    durationTicks: endTick - start.startTick,
                                    velocity: start.velocity
                                });
                            }
                        }
                    }
                    break;
                }
            }
        }

        // Choose initial meta at tick 0 if present, else first occurrence.
        function pickInitial(arr) {
            if (!arr || arr.length === 0) {
                return null;
            }
            for (const x of arr) {
                if (x.absTick === 0) {
                    return x;
                }
            }
            return arr[0];
        }

        const tempo0 = pickInitial(tempoEvents);
        const ts0 = pickInitial(timeSigEvents);
        const ks0 = pickInitial(keySigEvents);

        let bpm = null;
        if (tempo0 && tempo0.microsPerQuarter) {
            bpm = (60 * 1000000) / tempo0.microsPerQuarter;
        }

        // Time signature defaults
        const ts = ts0 ? { numerator: ts0.numerator, denominator: ts0.denominator } : { numerator: 4, denominator: 4 };
        const ticksPerBeat = midiDivisions * (4 / ts.denominator);
        const ticksPerBar = Math.max(1, Math.round(ticksPerBeat * ts.numerator));

        const maxTick = absTick;
        const barCount = Math.max(1, Math.ceil(maxTick / ticksPerBar));
        const maxBarsForAnalysis = getValueOrDefault(options, "maxBars", 512);
        const barsToAnalyze = Math.min(barCount, maxBarsForAnalysis);

        // Bar-level features
        const bars = [];
        for (let i = 0; i < barsToAnalyze; i++) {
            bars.push({
                index: i,
                noteOnCount: 0,
                drumHitCount: 0,
                avgVelocity: 0,
                velocitySum: 0,
                velocityCount: 0,
                chroma: createFilledArray(12, 0)
            });
        }

        for (const n of notes) {
            const barIndex = Math.floor(n.startTick / ticksPerBar);
            if (barIndex < 0 || barIndex >= barsToAnalyze) {
                continue;
            }
            const bar = bars[barIndex];
            const pc = positiveMod(n.pitch, 12);
            bar.noteOnCount += 1;
            bar.velocitySum += n.velocity;
            bar.velocityCount += 1;
            bar.chroma[pc] += 1;
            if (n.channel === 9) {
                bar.drumHitCount += 1;
            }
        }
        for (const b of bars) {
            b.avgVelocity = b.velocityCount ? (b.velocitySum / b.velocityCount) : 0;
        }

        function rotateChromaToMax(chroma) {
            let maxV = -1;
            let maxI = 0;
            for (let i = 0; i < 12; i++) {
                if (chroma[i] > maxV) {
                    maxV = chroma[i];
                    maxI = i;
                }
            }
            const rot = [];
            for (let i = 0; i < 12; i++) {
                rot[i] = chroma[(i + maxI) % 12];
            }
            return rot;
        }

        function bucket(v, step, maxBucket) {
            const b = Math.floor(v / step);
            return clamp(b, 0, maxBucket);
        }

        function barSignature(bar) {
            const rot = rotateChromaToMax(bar.chroma);
            const parts = [];
            for (let i = 0; i < rot.length; i++) {
                parts.push(bucket(rot[i], 2, 5));
            }
            parts.push("N" + bucket(bar.noteOnCount, 8, 8));
            parts.push("D" + bucket(bar.drumHitCount, 6, 8));
            parts.push("V" + bucket(bar.avgVelocity, 16, 8));
            return parts.join(".");
        }

        const barSigs = bars.map(barSignature);

        // Find repeating sequences of bars (simple hash matching)
        function findRepeats(minLen, maxLen) {
            const repeats = [];
            const maxL = Math.min(maxLen, Math.floor(barsToAnalyze / 2));
            for (let L = maxL; L >= minLen; L--) {
                const seen = {};
                for (let i = 0; i + L <= barsToAnalyze; i++) {
                    const key = barSigs.slice(i, i + L).join("|");
                    if (seen[key] != null) {
                        repeats.push({ length: L, a: seen[key], b: i });
                    } else {
                        seen[key] = i;
                    }
                }
                if (repeats.length) {
                    // Prefer longer repeats; stop early once we have some.
                    break;
                }
            }
            return repeats;
        }

        const repeats = findRepeats(4, 16);

        // Infer a simple A/B(/C) form from the best repeat(s)
        const sections = [];
        if (repeats.length) {
            const best = repeats[0];
            const L = best.length;
            // Candidate A sections at best.a and best.b
            sections.push({ label: "A", startBar: best.a, endBar: best.a + L - 1 });
            sections.push({ label: "A", startBar: best.b, endBar: best.b + L - 1 });

            // Anything between first A and second A that doesn't overlap becomes B
            const gapStart = best.a + L;
            const gapEnd = best.b - 1;
            if (gapEnd >= gapStart) {
                sections.push({ label: "B", startBar: gapStart, endBar: gapEnd });
            }

            // Trailing after second A becomes B' or C
            const tailStart = best.b + L;
            if (tailStart < barsToAnalyze) {
                sections.push({ label: "B", startBar: tailStart, endBar: barsToAnalyze - 1 });
            }
        }

        function sectionEnergy(sec) {
            let n = 0;
            let drum = 0;
            let vel = 0;
            let count = 0;
            for (let i = sec.startBar; i <= sec.endBar; i++) {
                if (i < 0 || i >= barsToAnalyze) {
                    continue;
                }
                const b = bars[i];
                n += b.noteOnCount;
                drum += b.drumHitCount;
                vel += b.avgVelocity;
                count += 1;
            }
            if (!count) {
                return 0;
            }
            return (n / count) + 0.75 * (drum / count) + 0.15 * (vel / count);
        }

        // Merge & normalize sections
        const normalizedSections = [];
        if (sections.length) {
            // Sort and merge same-label overlaps
            sections.sort((a, b) => a.startBar - b.startBar);
            for (const s of sections) {
                const last = normalizedSections.length ? normalizedSections[normalizedSections.length - 1] : null;
                if (last && last.label === s.label && s.startBar <= last.endBar + 1) {
                    last.endBar = Math.max(last.endBar, s.endBar);
                } else {
                    normalizedSections.push({ label: s.label, startBar: s.startBar, endBar: s.endBar });
                }
            }
        }

        // Role inference by channel (melody/bass)
        function averagePitch(ch) {
            const sum = channelNotePitchSum[ch] || 0;
            const cnt = channelNotePitchCount[ch] || 0;
            return cnt ? (sum / cnt) : null;
        }

        const channelStats = [];
        for (let ch = 0; ch < 16; ch++) {
            const cnt = channelNotePitchCount[ch] || 0;
            if (!cnt) {
                continue;
            }
            channelStats.push({
                channel: ch,
                noteCount: cnt,
                avgPitch: averagePitch(ch),
                program: typeof programByChannel[ch] === 'number' ? programByChannel[ch] : 0
            });
        }

        const nonDrum = channelStats.filter(x => x.channel !== 9);
        nonDrum.sort((a, b) => b.noteCount - a.noteCount);

        // Choose melody as the busiest of the higher-pitched half; bass as the lowest average pitch.
        let melodyChannel = null;
        let bassChannel = null;
        if (nonDrum.length) {
            const byPitch = nonDrum.slice().sort((a, b) => (a.avgPitch || 0) - (b.avgPitch || 0));
            bassChannel = byPitch[0].channel;

            const high = nonDrum.slice().sort((a, b) => (b.avgPitch || 0) - (a.avgPitch || 0));
            // Filter out channels with tiny note counts
            const highCandidates = high.filter(x => x.noteCount >= 8);
            melodyChannel = (highCandidates.length ? highCandidates[0] : high[0]).channel;
        }

        // Inner parts are other prominent channels
        const innerCandidates = nonDrum
            .filter(x => x.channel !== melodyChannel && x.channel !== bassChannel)
            .sort((a, b) => b.noteCount - a.noteCount);

        const inner1Channel = innerCandidates.length ? innerCandidates[0].channel : null;
        const inner2Channel = innerCandidates.length > 1 ? innerCandidates[1].channel : null;

        const roleChannels = {
            melody: melodyChannel,
            bass: bassChannel,
            inner1: inner1Channel,
            inner2: inner2Channel,
            drums: 9
        };

        // Bar energy stats (useful for distinguishing loop/monotone vs chorus contrast)
        const barEnergies = [];
        for (let i = 0; i < bars.length; i++) {
            const b = bars[i];
            const e = b.noteOnCount + 0.75 * b.drumHitCount + 0.15 * b.avgVelocity;
            barEnergies.push(e);
        }

        function mean(arr) {
            if (!arr || !arr.length) {
                return 0;
            }
            let s = 0;
            for (const v of arr) {
                s += v;
            }
            return s / arr.length;
        }
        function stddev(arr) {
            if (!arr || arr.length < 2) {
                return 0;
            }
            const m = mean(arr);
            let s2 = 0;
            for (const v of arr) {
                const d = v - m;
                s2 += d * d;
            }
            return Math.sqrt(s2 / (arr.length - 1));
        }

        const barEnergyMean = mean(barEnergies);
        const barEnergyStdDev = stddev(barEnergies);
        const barEnergyCv = barEnergyMean > 0 ? (barEnergyStdDev / barEnergyMean) : 0;

        // Label energy stats (if we have inferred sections)
        const labelEnergyAvgs = {};
        const labelCounts = {};
        if (normalizedSections && normalizedSections.length) {
            for (const s of normalizedSections) {
                const e = sectionEnergy(s);
                labelEnergyAvgs[s.label] = (labelEnergyAvgs[s.label] || 0) + e;
                labelCounts[s.label] = (labelCounts[s.label] || 0) + 1;
            }
            for (const lbl in labelEnergyAvgs) {
                labelEnergyAvgs[lbl] = labelEnergyAvgs[lbl] / (labelCounts[lbl] || 1);
            }
        }

        let labelEnergyContrast = 1.0;
        const labels = Object.keys(labelEnergyAvgs);
        if (labels.length >= 2) {
            let minE = Infinity;
            let maxE = -Infinity;
            for (const lbl of labels) {
                const e = labelEnergyAvgs[lbl];
                minE = Math.min(minE, e);
                maxE = Math.max(maxE, e);
            }
            labelEnergyContrast = (minE > 0) ? (maxE / minE) : (maxE > 0 ? 999 : 1.0);
        }

        // Suggested form: repeats often imply "loop" in game music unless there is a strong contrast.
        const hasRepeats = !!(repeats && repeats.length);
        const hasMultipleLabels = labels.length >= 2;
        const strongContrast = hasMultipleLabels && labelEnergyContrast >= 1.35;
        const monotoneOverall = barEnergyCv <= 0.18;

        let suggestedForm = "build";
        if (hasRepeats) {
            suggestedForm = strongContrast ? "verseChorus" : "loop";
        } else if (monotoneOverall) {
            suggestedForm = "loop";
        }

        return {
            bpm: bpm,
            timeSignature: ts0 ? { numerator: ts0.numerator, denominator: ts0.denominator } : null,
            keySignature: ks0 ? { sf: ks0.sf, mi: ks0.mi } : null,
            midiDivisions: midiDivisions,
            ticksPerBar: ticksPerBar,
            maxTick: maxTick,
            barCount: barCount,
            analyzedBars: barsToAnalyze,
            programByChannel: programByChannel,
            programCounts: programCounts,
            notes: notes,
            barSummaries: bars,
            repeats: repeats,
            sections: normalizedSections,
            roleChannels: roleChannels,
            barEnergyMean: barEnergyMean,
            barEnergyStdDev: barEnergyStdDev,
            barEnergyCv: barEnergyCv,
            labelEnergyAvgs: labelEnergyAvgs,
            labelEnergyContrast: labelEnergyContrast,
            suggestedForm: suggestedForm
        };
    }

    function clamp(n, min, max) {
        return Math.max(min, Math.min(max, n));
    }

    function keyNameToPitchClass(name) {
        const map = {
            "C": 0,
            "C#": 1,
            "Db": 1,
            "D": 2,
            "D#": 3,
            "Eb": 3,
            "E": 4,
            "F": 5,
            "F#": 6,
            "Gb": 6,
            "G": 7,
            "G#": 8,
            "Ab": 8,
            "A": 9,
            "A#": 10,
            "Bb": 10,
            "B": 11,
            "Cb": 11
        };
        const pc = map[name];
        return typeof pc === 'number' ? pc : null;
    }

    function keySignatureToName(ks) {
        if (!ks) {
            return null;
        }
        const majorBySf = {
            "-7": "Cb",
            "-6": "Gb",
            "-5": "Db",
            "-4": "Ab",
            "-3": "Eb",
            "-2": "Bb",
            "-1": "F",
            "0": "C",
            "1": "G",
            "2": "D",
            "3": "A",
            "4": "E",
            "5": "B",
            "6": "F#",
            "7": "C#"
        };
        const minorBySf = {
            "-7": "Ab",
            "-6": "Eb",
            "-5": "Bb",
            "-4": "F",
            "-3": "C",
            "-2": "G",
            "-1": "D",
            "0": "A",
            "1": "E",
            "2": "B",
            "3": "F#",
            "4": "C#",
            "5": "G#",
            "6": "D#",
            "7": "A#"
        };

        const table = ks.mi === 1 ? minorBySf : majorBySf;
        const keyName = table[String(ks.sf)];
        if (!keyName) {
            return null;
        }
        return keyName + (ks.mi === 1 ? " minor" : " major");
    }

    function guessInstrumentTypeLikelihoods(programCounts) {
        // Very rough heuristic: bias based on where most programs fall.
        const synthMin = 80;
        const synthMax = 119;

        let total = 0;
        let synth = 0;
        let electric = 0;
        let acoustic = 0;

        for (const pStr in programCounts) {
            const p = parseInt(pStr);
            const c = programCounts[pStr] || 0;
            total += c;

            if (p >= synthMin && p <= synthMax) {
                synth += c;
            } else if ((p >= 24 && p <= 31) || (p >= 32 && p <= 39) || (p >= 40 && p <= 47)) {
                // Guitars + bass + strings
                electric += c;
            } else {
                acoustic += c;
            }
        }

        if (total <= 0) {
            return null;
        }

        const synthFrac = synth / total;
        const electricFrac = electric / total;

        if (synthFrac > 0.45) {
            return { electronicLikelihood: 6.0, electricLikelihood: 1.0, acousticLikelihood: 0.5 };
        }
        if (electricFrac > 0.45) {
            return { electronicLikelihood: 0.75, electricLikelihood: 6.0, acousticLikelihood: 1.0 };
        }
        return { electronicLikelihood: 0.75, electricLikelihood: 1.0, acousticLikelihood: 6.0 };
    }

    function analysisToGenInfo(analysis, options) {
        options = options || {};
        const genInfo = {};

        function canCreateSongPartInfos() {
            return (typeof SongPartStructureInfo !== 'undefined') &&
                (typeof SongPartType !== 'undefined') &&
                (typeof SongPartStrength !== 'undefined');
        }

        function indicatorToSongPartType(ind) {
            switch (ind) {
                case "verse1": return SongPartType.VERSE_1;
                case "verse2": return SongPartType.VERSE_2;
                case "chorus1": return SongPartType.CHORUS_1;
                case "chorus2": return SongPartType.CHORUS_2;
                case "bridge1": return SongPartType.BRIDGE_1;
                case "bridge2": return SongPartType.BRIDGE_2;
                case "misc1": return SongPartType.MISC_1;
                case "misc2": return SongPartType.MISC_2;
            }
            return SongPartType.VERSE_1;
        }

        function makeSongPartStructureInfo(indicator, strength) {
            const info = new SongPartStructureInfo({strength: strength});
            info.partType = indicatorToSongPartType(indicator);
            return info;
        }

        function makeSongPartStructureInfoDataSample(indicators) {
            if (!canCreateSongPartInfos()) {
                return null;
            }
            const parts = [];
            for (const ind of indicators) {
                parts.push(makeSongPartStructureInfo(ind, SongPartStrength.MEDIUM));
            }
            return {
                data: parts,
                likelihood: 100,
                active: true,
                _constructorName: "SongPartStructureInfoDataSample"
            };
        }

        // Tempo
        if (analysis.bpm && isFinite(analysis.bpm)) {
            const bpm = clamp(analysis.bpm, 10, 500);
            const spread = Math.max(2, Math.round(bpm * 0.05));
            genInfo.tempoRange = [clamp(Math.round(bpm - spread), 10, 500), clamp(Math.round(bpm + spread), 10, 500)];
        }

        // Time signature likelihood
        if (analysis.timeSignature) {
            const num = analysis.timeSignature.numerator;
            const den = analysis.timeSignature.denominator;
            // Abundant Music mostly cares about 2/4, 3/4, 4/4.
            if (den === 4) {
                if (num === 4) {
                    genInfo.timeSignature4Likelihood = 10;
                    genInfo.timeSignature3Likelihood = 0.2;
                    genInfo.timeSignature2Likelihood = 0.2;
                } else if (num === 3) {
                    genInfo.timeSignature3Likelihood = 10;
                    genInfo.timeSignature4Likelihood = 0.2;
                    genInfo.timeSignature2Likelihood = 0.2;
                } else if (num === 2) {
                    genInfo.timeSignature2Likelihood = 10;
                    genInfo.timeSignature4Likelihood = 0.2;
                    genInfo.timeSignature3Likelihood = 0.2;
                }
            }
        }

        // Key / scale likelihood
        if (analysis.keySignature) {
            const isMinor = analysis.keySignature.mi === 1;
            genInfo.minorScaleLikelihood = isMinor ? 10 : 0.2;
            genInfo.majorScaleLikelihood = isMinor ? 0.2 : 10;
            // A gentle nudge for harmonic minor when minor
            genInfo.harmonicMinorScaleLikelihood = isMinor ? 1.5 : 0.0;

            const keyName = keySignatureToName(analysis.keySignature);
            if (keyName) {
                const tonicName = keyName.split(" ")[0];
                const pc = keyNameToPitchClass(tonicName);
                if (pc != null) {
                    genInfo.setScaleBaseNote = true;
                    genInfo.scaleBaseNote = 60 + pc;
                }
            }
        }

        // Instrument type likelihoods (acoustic/electric/electronic)
        const instrTypeLikes = guessInstrumentTypeLikelihoods(analysis.programCounts || {});
        if (instrTypeLikes) {
            genInfo.electronicLikelihood = instrTypeLikes.electronicLikelihood;
            genInfo.electricLikelihood = instrTypeLikes.electricLikelihood;
            genInfo.acousticLikelihood = instrTypeLikes.acousticLikelihood;
        }

        // Try to lock instruments to match the MIDI roles (this makes generated variations feel closer)
        function programForChannel(ch) {
            if (ch == null) {
                return null;
            }
            const p = analysis.programByChannel ? analysis.programByChannel[ch] : null;
            return (typeof p === 'number') ? p : 0;
        }
        const roles = analysis.roleChannels || {};
        const melodyProg = programForChannel(roles.melody);
        const bassProg = programForChannel(roles.bass);
        const inner1Prog = programForChannel(roles.inner1);
        const inner2Prog = programForChannel(roles.inner2);

        if (melodyProg != null) {
            genInfo.overwriteMelodyInstruments = true;
            genInfo.melodyInstruments = [melodyProg];
        }
        if (bassProg != null) {
            genInfo.overwriteBassInstruments = true;
            genInfo.bassInstruments = [bassProg];
        }
        if (inner1Prog != null) {
            genInfo.overwriteInner1Instruments = true;
            genInfo.inner1Instruments = [inner1Prog];
        }
        if (inner2Prog != null) {
            genInfo.overwriteInner2Instruments = true;
            genInfo.inner2Instruments = [inner2Prog];
        }

        // Form handling
        // options.formMode: "auto" | "loop" | "verseChorus" | "build"
        const mode = getValueOrDefault(options, "formMode", "auto");
        const suggested = analysis && analysis.suggestedForm ? analysis.suggestedForm : "build";
        const effectiveMode = (mode === "auto") ? suggested : mode;

        // Start from neutral to avoid accidental Verse->Chorus bias for loop/game MIDIs.
        genInfo.buildSongStructureLikelihoodMultiplier = 1.0;
        genInfo.verseChorusSongStructureLikelihoodMultiplier = 1.0;
        genInfo.verseChorusBridgeSongStructureLikelihoodMultiplier = 1.0;

        if (effectiveMode === "verseChorus") {
            genInfo.verseChorusSongStructureLikelihoodMultiplier = 8.0;
            genInfo.verseChorusBridgeSongStructureLikelihoodMultiplier = (analysis.sections && analysis.sections.length >= 3) ? 2.5 : 1.0;
            genInfo.buildSongStructureLikelihoodMultiplier = 0.5;
        } else if (effectiveMode === "build") {
            genInfo.buildSongStructureLikelihoodMultiplier = 6.0;
            genInfo.verseChorusSongStructureLikelihoodMultiplier = 0.4;
            genInfo.verseChorusBridgeSongStructureLikelihoodMultiplier = 0.25;
        } else if (effectiveMode === "loop") {
            // Prefer a monotone/loop-like structure: no explicit chorus.
            genInfo.buildSongStructureLikelihoodMultiplier = 6.0;
            genInfo.verseChorusSongStructureLikelihoodMultiplier = 0.15;
            genInfo.verseChorusBridgeSongStructureLikelihoodMultiplier = 0.05;
            genInfo.songIntroProbability = 0.0;
            genInfo.songEndProbability = 0.0;

            // Hard override: repeated Verse parts only (avoid chorus entirely).
            const loopSample = makeSongPartStructureInfoDataSample(["verse1", "verse1", "verse1", "verse1", "verse1", "verse1"]);
            if (loopSample) {
                genInfo.overwriteSongPartStructureRndInfos = true;
                genInfo.songPartStructureRndInfos = [loopSample];
            }
        }

        // If melody is weak in at least one section, raise chance of no-melody part.
        if (analysis.sections && analysis.sections.length && analysis.roleChannels && analysis.notes) {
            const melodyCh = analysis.roleChannels.melody;
            if (melodyCh != null && analysis.ticksPerBar) {
                const ticksPerBar = analysis.ticksPerBar;
                const melodyNotes = analysis.notes.filter(n => n.channel === melodyCh);
                const melodyNoteStartsByBar = {};
                for (const n of melodyNotes) {
                    const b = Math.floor(n.startTick / ticksPerBar);
                    melodyNoteStartsByBar[b] = (melodyNoteStartsByBar[b] || 0) + 1;
                }
                let anyLowMelody = false;
                for (const s of analysis.sections) {
                    let countBars = 0;
                    let sum = 0;
                    for (let b = s.startBar; b <= s.endBar; b++) {
                        sum += (melodyNoteStartsByBar[b] || 0);
                        countBars += 1;
                    }
                    const perBar = countBars ? (sum / countBars) : 0;
                    if (perBar < 1.5) {
                        anyLowMelody = true;
                        break;
                    }
                }
                if (anyLowMelody) {
                    genInfo.noMelodyPartSongStructureLikelihoodMultiplier = 3.0;
                }
            }
        }

        // Hard override: provide a custom part-order suggestion when we can infer an A/B form.
        // Only do this when the effective mode is verse/chorus (otherwise game/loop MIDIs get mis-labeled).
        if (effectiveMode === "verseChorus" && analysis.sections && analysis.sections.length >= 2) {
            // Determine which label is chorus by energy (higher energy => chorus)
            const energyByLabel = {};
            const countsByLabel = {};
            for (const s of analysis.sections) {
                const bStart = s.startBar;
                const bEnd = s.endBar;
                let eSum = 0;
                let eCount = 0;
                if (analysis.barSummaries) {
                    for (let i = bStart; i <= bEnd; i++) {
                        const bar = analysis.barSummaries[i];
                        if (!bar) {
                            continue;
                        }
                        const e = bar.noteOnCount + 0.75 * bar.drumHitCount + 0.15 * bar.avgVelocity;
                        eSum += e;
                        eCount += 1;
                    }
                }
                const eAvg = eCount ? (eSum / eCount) : 0;
                energyByLabel[s.label] = (energyByLabel[s.label] || 0) + eAvg;
                countsByLabel[s.label] = (countsByLabel[s.label] || 0) + 1;
            }
            let bestLabel = null;
            let bestEnergy = -1;
            for (const lbl in energyByLabel) {
                const avg = energyByLabel[lbl] / (countsByLabel[lbl] || 1);
                if (avg > bestEnergy) {
                    bestEnergy = avg;
                    bestLabel = lbl;
                }
            }

            function labelToPart(lbl) {
                return (lbl === bestLabel) ? "chorus1" : "verse1";
            }

            const indicators = [];
            // Build a part sequence in chronological order; collapse consecutive same-type.
            const ordered = analysis.sections.slice().sort((a, b) => a.startBar - b.startBar);
            for (const s of ordered) {
                const part = labelToPart(s.label);
                if (!indicators.length || indicators[indicators.length - 1] !== part) {
                    indicators.push(part);
                }
            }

            if (indicators.length >= 2) {
                const vcSample = makeSongPartStructureInfoDataSample(indicators);
                if (vcSample) {
                    genInfo.overwriteSongPartStructureRndInfos = true;
                    genInfo.songPartStructureRndInfos = [vcSample];
                }
            }
        }

        return genInfo;
    }

    function createPresetObject(genInfo, options) {
        const seed = getValueOrDefault(options, "seed", 20260116);
        return {
            seed: seed,
            genInfo: genInfo
        };
    }

    function downloadJsonObject(obj, filename) {
        const json = JSON.stringify(obj, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function summarizeAnalysis(analysis) {
        const rows = [];
        if (analysis.bpm) {
            rows.push("Tempo: " + (Math.round(analysis.bpm * 100) / 100) + " BPM");
        }
        if (analysis.timeSignature) {
            rows.push("Time signature: " + analysis.timeSignature.numerator + "/" + analysis.timeSignature.denominator);
        }
        if (analysis.keySignature) {
            const keyName = keySignatureToName(analysis.keySignature);
            if (keyName) {
                rows.push("Key: " + keyName);
            }
        }

        if (typeof analysis.analyzedBars === 'number' && typeof analysis.barCount === 'number') {
            rows.push("Bars: ~" + analysis.barCount + " (analyzed " + analysis.analyzedBars + ")");
        }

        if (analysis.roleChannels) {
            const rc = analysis.roleChannels;
            const bits = [];
            if (rc.melody != null) bits.push("melody ch " + (rc.melody + 1));
            if (rc.inner1 != null) bits.push("inner1 ch " + (rc.inner1 + 1));
            if (rc.inner2 != null) bits.push("inner2 ch " + (rc.inner2 + 1));
            if (rc.bass != null) bits.push("bass ch " + (rc.bass + 1));
            if (bits.length) {
                rows.push("Role guess: " + bits.join(", "));
            }
        }

        if (analysis.sections && analysis.sections.length) {
            const secStr = analysis.sections
                .slice()
                .sort((a, b) => a.startBar - b.startBar)
                .map(s => s.label + ": bars " + (s.startBar + 1) + "-" + (s.endBar + 1))
                .join(" | ");
            rows.push("Sections: " + secStr);
        }

        if (analysis && analysis.suggestedForm) {
            rows.push("Suggested form: " + analysis.suggestedForm);
        }
        if (analysis && typeof analysis.labelEnergyContrast === 'number' && isFinite(analysis.labelEnergyContrast)) {
            rows.push("Section energy contrast: " + (Math.round(analysis.labelEnergyContrast * 100) / 100));
        }
        if (analysis && typeof analysis.barEnergyCv === 'number' && isFinite(analysis.barEnergyCv)) {
            rows.push("Overall energy variation (CV): " + (Math.round(analysis.barEnergyCv * 100) / 100));
        }

        const programs = [];
        const progCounts = analysis.programCounts || {};
        for (const pStr in progCounts) {
            programs.push({ p: parseInt(pStr), c: progCounts[pStr] });
        }
        programs.sort((a, b) => b.c - a.c);
        if (programs.length) {
            const top = programs.slice(0, 8)
                .map(x => {
                    const name = (typeof MidiProgram !== 'undefined' && MidiProgram.toString) ? MidiProgram.toString(x.p) : ("Program " + x.p);
                    return name + " ×" + x.c;
                })
                .join(", ");
            rows.push("Programs (top): " + top);
        }

        return rows;
    }

    return {
        parseSmf: parseSmf,
        analyzeMergedEvents: analyzeMergedEvents,
        analysisToGenInfo: analysisToGenInfo,
        createPresetObject: createPresetObject,
        downloadJsonObject: downloadJsonObject,
        summarizeAnalysis: summarizeAnalysis,
        keySignatureToName: keySignatureToName
    };

})();
