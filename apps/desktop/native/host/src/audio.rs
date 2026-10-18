//! The sound of a screen share, without the voice chats. Windows can capture the audio of one
//! process tree (a "process loopback"); this captures one or several and writes the mix to the
//! standard output as raw PCM: 48 kHz, stereo, signed 16-bit little endian, at a steady pace.
//!
//!   dispeaker-host audio --window <handle>  the program that owns that window
//!   dispeaker-host audio --covering         the program whose window covers a whole monitor
//!   dispeaker-host audio --process <id>     that process
//!   ... --or-mix                            when no such program: everything that plays,
//!                                           except voice chats and the excluded processes
//!   ... --exclude <id,id>                   never these processes (the app itself)
//!
//! The first line on the standard error is JSON: `{"processId":1234,"name":"Control"}` for one
//! program, `{"mix":true}` for the mix. The exit code is 2 when there is nothing to capture and 3
//! when Windows refuses (it needs Windows 10 2004 or newer). Closing the standard input ends it.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, IAudioSessionControl2, IAudioSessionManager2,
    IMMDeviceEnumerator, MMDeviceEnumerator, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVE_FORMAT_PCM, WAVEFORMATEX, eConsole, eRender,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, IAgileObject,
    IAgileObject_Impl,
};
use windows::Win32::System::Threading::{
    CreateEventW, OpenProcess, PROCESS_SYNCHRONIZE, SetEvent, WaitForSingleObject,
};
use windows::core::{IUnknown, Interface, PROPVARIANT, Result, implement};

use crate::display;
use crate::games;
use crate::processes;

const SAMPLE_RATE: usize = 48_000;
const CHANNELS: usize = 2;
const BYTES_PER_FRAME: usize = CHANNELS * 2;

/// Voice chats: what is said there must not go out with the stream. Matched against the name
/// of the process file, without ".exe".
const VOICE_CHATS: &[&str] = &[
    "discord",
    "discordptb",
    "discordcanary",
    "dispeaker",
    "ts3client_win64",
    "ts3client_win32",
    "teamspeak",
    "skype",
    "zoom",
    "ms-teams",
    "teams",
    "whatsapp",
    "telegram",
    "mumble",
    "slack",
];

/// The sound of one process tree, kept until the mixer takes it.
struct Source {
    process_id: u32,
    state: Mutex<SourceState>,
}

#[derive(Default)]
struct SourceState {
    pieces: VecDeque<Vec<i16>>,
    head: Vec<i16>,
    offset: usize,
    frames: usize,
    playing: bool,
}

/// Held back before it plays (again), so a late packet does not become a gap: 30 ms.
const START_FRAMES: usize = 1440;
/// Above this the mixer is not keeping up with the device: the oldest sound goes.
const MAX_FRAMES: usize = 9600;

impl Source {
    fn push(&self, piece: Vec<i16>) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.frames += piece.len() / CHANNELS;
        state.pieces.push_back(piece);
        while state.frames > MAX_FRAMES && state.pieces.len() > 1 {
            let dropped = state.pieces.pop_front().map_or(0, |p| p.len());
            state.frames -= dropped / CHANNELS;
        }
    }

    /// Adds up to `count` frames to `mix`; silence where there is nothing to play.
    fn mix_into(&self, mix: &mut [i32], count: usize) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if !state.playing && state.frames >= START_FRAMES {
            state.playing = true;
        }
        if !state.playing {
            return;
        }
        for frame in 0..count {
            if state.offset >= state.head.len() {
                let Some(next) = state.pieces.pop_front() else {
                    state.playing = false;
                    state.head.clear();
                    state.offset = 0;
                    return;
                };
                state.head = next;
                state.offset = 0;
            }
            let offset = state.offset;
            mix[frame * 2] += i32::from(state.head[offset]);
            mix[frame * 2 + 1] += i32::from(state.head[offset + 1]);
            state.offset += 2;
            state.frames = state.frames.saturating_sub(1);
        }
    }
}

type Sources = Arc<Mutex<Vec<Arc<Source>>>>;

#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct Activation {
    done: HANDLE,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for Activation_Impl {
    fn ActivateCompleted(&self, _: Option<&IActivateAudioInterfaceAsyncOperation>) -> Result<()> {
        unsafe { SetEvent(self.done) }
    }
}

impl IAgileObject_Impl for Activation_Impl {}

/// A PROPVARIANT holding a blob (VT_BLOB): type, padding, size, pointer.
#[repr(C)]
struct BlobVariant {
    vt: u16,
    reserved: [u16; 3],
    size: u32,
    data: *const u8,
    padding: usize,
}

/// An audio client for the sound of a process and every process it started.
fn activate(process_id: u32) -> Result<IAudioClient> {
    let parameters = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: process_id,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    let variant = BlobVariant {
        vt: 65, // VT_BLOB
        reserved: [0; 3],
        size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        data: &parameters as *const _ as *const u8,
        padding: 0,
    };
    unsafe {
        let done = CreateEventW(None, false, false, None)?;
        let handler: IActivateAudioInterfaceCompletionHandler = Activation { done }.into();
        let operation = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&variant as *const BlobVariant as *const PROPVARIANT),
            &handler,
        )?;
        let waited = WaitForSingleObject(done, 5000);
        let _ = CloseHandle(done);
        if waited != WAIT_OBJECT_0 {
            return Err(windows::core::Error::new(
                windows::Win32::Foundation::E_FAIL,
                "activation did not complete",
            ));
        }
        let mut result = windows::core::HRESULT(0);
        let mut activated: Option<IUnknown> = None;
        operation.GetActivateResult(&mut result, &mut activated)?;
        result.ok()?;
        activated
            .ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?
            .cast()
    }
}

/// Starts capturing one process tree on a thread of its own.
fn start_source(process_id: u32, sources: &Sources) -> Result<()> {
    let client = activate(process_id)?;
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: CHANNELS as u16,
        nSamplesPerSec: SAMPLE_RATE as u32,
        nAvgBytesPerSec: (SAMPLE_RATE * BYTES_PER_FRAME) as u32,
        nBlockAlign: BYTES_PER_FRAME as u16,
        wBitsPerSample: 16,
        cbSize: 0,
    };
    let (capture, ready) = unsafe {
        // 20 ms of buffer.
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            200_000,
            0,
            &format,
            None,
        )?;
        let capture: IAudioCaptureClient = client.GetService()?;
        let ready = CreateEventW(None, false, false, None)?;
        client.SetEventHandle(ready)?;
        client.Start()?;
        (capture, ready)
    };
    let source = Arc::new(Source {
        process_id,
        state: Mutex::default(),
    });
    if let Ok(mut list) = sources.lock() {
        list.push(source.clone());
    }
    // The handles cross into the thread as numbers; the thread owns them from here on.
    let ready = ready.0 as isize;
    let client = client.into_raw() as isize;
    let capture = capture.into_raw() as isize;
    thread::spawn(move || unsafe {
        let ready = HANDLE(ready as *mut std::ffi::c_void);
        let _client = IAudioClient::from_raw(client as *mut std::ffi::c_void);
        let capture = IAudioCaptureClient::from_raw(capture as *mut std::ffi::c_void);
        loop {
            if WaitForSingleObject(ready, 1000) != WAIT_OBJECT_0 {
                continue;
            }
            while let Ok(size) = capture.GetNextPacketSize() {
                if size == 0 {
                    break;
                }
                let mut data = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                if capture
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                    .is_err()
                {
                    break;
                }
                let samples = frames as usize * CHANNELS;
                let piece = if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null()
                {
                    vec![0i16; samples]
                } else {
                    std::slice::from_raw_parts(data as *const i16, samples).to_vec()
                };
                let _ = capture.ReleaseBuffer(frames);
                source.push(piece);
            }
        }
    });
    Ok(())
}

/// Process ids of the programs playing sound on the default output right now.
fn playing_now() -> Result<HashSet<u32>> {
    let mut playing = HashSet::new();
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
        let sessions = manager.GetSessionEnumerator()?;
        for index in 0..sessions.GetCount()? {
            let Ok(session) = sessions.GetSession(index) else {
                continue;
            };
            let Ok(control) = session.cast::<IAudioSessionControl2>() else {
                continue;
            };
            if let Ok(pid) = control.GetProcessId()
                && pid != 0
            {
                playing.insert(pid);
            }
        }
    }
    Ok(playing)
}

fn ancestors(id: u32, parents: &HashMap<u32, u32>) -> Vec<u32> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    let mut current = id;
    while let Some(&parent) = parents.get(&current) {
        if parent == 0 || !seen.insert(parent) || seen.len() >= 64 {
            break;
        }
        found.push(parent);
        current = parent;
    }
    found
}

/// Voice chats running now, and the processes the caller excluded.
fn forbidden(excluded: &HashSet<u32>, running: &[processes::Process]) -> HashSet<u32> {
    let mut forbidden: HashSet<u32> = excluded.clone();
    for process in running {
        let name = process.exe.to_lowercase();
        let name = name.strip_suffix(".exe").unwrap_or(&name);
        if VOICE_CHATS.contains(&name) {
            forbidden.insert(process.pid);
        }
    }
    forbidden
}

/// Whether capturing the tree of `target` would take a voice chat (or an excluded process) with
/// it: a window of the shell, or of a launcher that started Discord, is not "a program alone".
fn tree_holds_forbidden(target: u32, excluded: &HashSet<u32>) -> bool {
    let running = processes::all();
    let parents: HashMap<u32, u32> = running.iter().map(|p| (p.pid, p.parent)).collect();
    forbidden(excluded, &running)
        .iter()
        .any(|&id| ancestors(id, &parents).contains(&target))
}

/// Everything that plays sound on the default output, except voice chats and `excluded`. A
/// capture takes a whole process tree, so a program is left out when a voice chat descends from
/// it (the shell starts everything), and when an ancestor is captured already (a game started by
/// its launcher would be heard twice).
fn add_playing(excluded: &HashSet<u32>, sources: &Sources, first: bool) -> Result<()> {
    let playing = playing_now()?;
    let running = processes::all();
    let parents: HashMap<u32, u32> = running.iter().map(|p| (p.pid, p.parent)).collect();
    let forbidden = forbidden(excluded, &running);
    let taken: HashSet<u32> = sources
        .lock()
        .map(|list| list.iter().map(|s| s.process_id).collect())
        .unwrap_or_default();
    let unsafe_roots: HashSet<u32> = forbidden
        .iter()
        .flat_map(|&id| ancestors(id, &parents))
        .collect();
    let usable = |id: u32| !forbidden.contains(&id) && !unsafe_roots.contains(&id);

    let mut failure = None;
    let mut started = 0;
    for &id in &playing {
        if taken.contains(&id) || !usable(id) {
            continue;
        }
        let covered = ancestors(id, &parents)
            .iter()
            .any(|&a| (playing.contains(&a) && usable(a)) || taken.contains(&a));
        if covered {
            continue;
        }
        match start_source(id, sources) {
            Ok(()) => started += 1,
            Err(error) => failure = Some(error),
        }
    }
    match failure {
        Some(error) if first && started == 0 => Err(error),
        _ => Ok(()),
    }
}

fn report(value: serde_json::Value) {
    let mut error = std::io::stderr().lock();
    let _ = writeln!(error, "{value}");
    let _ = error.flush();
}

/// What the program calls itself, or the name of its file.
fn name_of(process_id: u32) -> String {
    processes::path_of(process_id)
        .and_then(|path| {
            games::description_of(&path).or_else(|| {
                std::path::Path::new(&path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
            })
        })
        .unwrap_or_default()
}

/// Writes the sum of the sources at the device's pace, 10 ms at a time, until the output closes
/// or the one program captured ends.
fn mix(single: Option<u32>, sources: &Sources) -> i32 {
    let process =
        single.and_then(|pid| unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }.ok());
    let clock = Instant::now();
    let mut written: usize = 0;
    let mut mix = vec![0i32; SAMPLE_RATE / 10 * CHANNELS];
    let mut bytes = vec![0u8; mix.len() * 2];
    let mut checked = Instant::now();
    let mut output = std::io::stdout().lock();
    loop {
        thread::sleep(Duration::from_millis(5));
        let mut due = (clock.elapsed().as_secs_f64() * SAMPLE_RATE as f64) as usize - written;
        // After a long stall the gap is not made up: that sound is gone anyway.
        if due > SAMPLE_RATE / 10 {
            written += due - SAMPLE_RATE / 100;
            due = SAMPLE_RATE / 100;
        }
        if due < SAMPLE_RATE / 100 {
            continue;
        }
        let samples = due * CHANNELS;
        mix[..samples].fill(0);
        let current: Vec<Arc<Source>> = sources.lock().map(|l| l.clone()).unwrap_or_default();
        for source in &current {
            source.mix_into(&mut mix, due);
        }
        for (index, sample) in mix[..samples].iter().enumerate() {
            let clamped = (*sample).clamp(-32768, 32767) as i16;
            bytes[index * 2..index * 2 + 2].copy_from_slice(&clamped.to_le_bytes());
        }
        if output
            .write_all(&bytes[..samples * 2])
            .and_then(|()| output.flush())
            .is_err()
        {
            return 0;
        }
        written += due;
        if let Some(handle) = process
            && checked.elapsed() > Duration::from_secs(1)
        {
            checked = Instant::now();
            if unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0 {
                return 0;
            }
        }
    }
}

/// `dispeaker-host audio …`: see the top of this file. Returns the exit code.
pub fn run(arguments: &[String]) -> i32 {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let mut target: u32 = 0;
    let mut excluded = HashSet::new();
    let mut covering = false;
    let mut or_mix = false;
    let mut index = 0;
    while index < arguments.len() {
        let next = arguments.get(index + 1);
        match arguments[index].as_str() {
            "--covering" => covering = true,
            "--or-mix" => or_mix = true,
            "--window" => {
                if let Some(handle) = next.and_then(|v| v.parse::<i64>().ok()) {
                    target = crate::windows_info::process_of_handle(handle);
                }
                index += 1;
            }
            "--process" => {
                target = next.and_then(|v| v.parse().ok()).unwrap_or(0);
                index += 1;
            }
            "--exclude" => {
                excluded.extend(
                    next.into_iter()
                        .flat_map(|v| v.split(','))
                        .filter_map(|v| v.parse::<u32>().ok()),
                );
                index += 1;
            }
            _ => {}
        }
        index += 1;
    }
    if covering {
        target = display::find_covering(&excluded);
    }
    // A program whose tree holds a voice chat would bring the voices along: the mix leaves them out.
    if excluded.contains(&target) || (target != 0 && tree_holds_forbidden(target, &excluded)) {
        target = 0;
    }

    let sources: Sources = Arc::default();
    if target != 0 {
        if let Err(error) = start_source(target, &sources) {
            report(json!({ "error": error.message() }));
            return 3;
        }
        report(json!({ "processId": target, "name": name_of(target) }));
    } else if or_mix {
        // A first look decides whether Windows can do this at all; later ones only add.
        if let Err(error) = add_playing(&excluded, &sources, true) {
            report(json!({ "error": error.message() }));
            return 3;
        }
        report(json!({ "mix": true }));
        let sources = sources.clone();
        thread::spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            loop {
                thread::sleep(Duration::from_secs(3));
                let _ = add_playing(&excluded, &sources, false);
            }
        });
    } else {
        return 2;
    }

    // Whoever started this closes its standard input to end it, or dies and closes it anyway.
    thread::spawn(|| {
        let mut scratch = [0u8; 64];
        let mut input = std::io::stdin();
        while matches!(input.read(&mut scratch), Ok(n) if n > 0) {}
        std::process::exit(0);
    });

    mix((target != 0).then_some(target), &sources)
}
