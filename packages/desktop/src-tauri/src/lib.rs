use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WebviewWindow,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(serde::Serialize)]
struct ServerCredentials {
    url: String,
    token: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    shortcut_error: Option<String>,
}

#[derive(Clone, Default)]
struct SidecarState {
    port: Arc<Mutex<Option<u16>>>,
    token: Arc<Mutex<Option<String>>>,
    child: Arc<Mutex<Option<Child>>>,
    shortcut_error: Arc<Mutex<Option<String>>>,
}

#[tauri::command]
fn server_credentials(state: tauri::State<'_, SidecarState>) -> Result<Option<ServerCredentials>, String> {
    let port = *state.port.lock().map_err(|error| error.to_string())?;
    let token = state.token.lock().map_err(|error| error.to_string())?.clone();

    Ok(match (port, token) {
        (Some(value), Some(token)) => Some(ServerCredentials {
            url: format!("http://127.0.0.1:{value}"),
            token,
        }),
        _ => None,
    })
}

#[tauri::command]
fn desktop_status(state: tauri::State<'_, SidecarState>) -> Result<DesktopStatus, String> {
    Ok(DesktopStatus {
        shortcut_error: state.shortcut_error.lock().map_err(|error| error.to_string())?.clone(),
    })
}

#[tauri::command]
fn show_capture(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("capture")
        .ok_or_else(|| "capture window not found".to_string())?;
    window.center().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_current_window(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn show_main(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(capture) = app.get_webview_window("capture") {
        let _ = capture.hide();
    }

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn capture_screenshot() -> Result<String, String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let path = std::env::temp_dir().join(format!("bmo-screenshot-{ts}.png"));
    let status = Command::new("/usr/sbin/screencapture")
        .arg("-i")
        .arg(&path)
        .status()
        .map_err(|error| error.to_string())?;

    if !status.success() {
        return Err("截图已取消".to_string());
    }

    Ok(path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            server_credentials,
            desktop_status,
            show_capture,
            hide_current_window,
            show_main,
            capture_screenshot
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            start_sidecar(app.handle().clone())?;
            setup_tray(app)?;
            setup_windows(app)?;
            setup_global_shortcut(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build BMO desktop")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                kill_sidecar(app);
            }
        });
}

fn setup_global_shortcut(app: &tauri::AppHandle) {
    if let Err(error) = app.global_shortcut().on_shortcut("CommandOrControl+Shift+M", |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            let _ = show_capture(app.clone());
        }
    }) {
        let message = format!("⌘⇧M 注册失败：{error}");
        if let Ok(mut shortcut_error) = app.state::<SidecarState>().shortcut_error.lock() {
            *shortcut_error = Some(message.clone());
        }
        eprintln!("{message}");
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示 BMO", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "喂点东西", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &capture, &quit])?;

    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                let _ = show_main(app.clone());
            }
            "capture" => {
                let _ = show_capture(app.clone());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = show_main(tray.app_handle().clone());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;
    Ok(())
}

fn setup_windows(app: &mut tauri::App) -> tauri::Result<()> {
    if let Some(main) = app.get_webview_window("main") {
        let main_window = main.clone();
        main.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = main_window.hide();
            }
        });
    }

    if let Some(capture) = app.get_webview_window("capture") {
        let capture_window = capture.clone();
        capture.on_window_event(move |event| {
            if let tauri::WindowEvent::Focused(false) = event {
                let _ = capture_window.hide();
            }
        });
        capture.hide()?;
    }

    Ok(())
}

fn start_sidecar(app: tauri::AppHandle) -> tauri::Result<()> {
    let mut command = sidecar_command(&app)?;
    let mut child = command
        .env("BMO_PARENT_PID", std::process::id().to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| tauri::Error::Anyhow(error.into()))?;

    let stdout = child.stdout.take();
    let state = app.state::<SidecarState>();
    *state.child.lock().map_err(|error| {
        tauri::Error::Io(std::io::Error::other(format!("sidecar state lock poisoned: {error}")))
    })? = Some(child);

    if let Some(stdout) = stdout {
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(raw_port) = line.strip_prefix("BMO_SERVER_PORT=") {
                    if let Ok(port) = raw_port.trim().parse::<u16>() {
                        if let Ok(mut target) = app.state::<SidecarState>().port.lock() {
                            *target = Some(port);
                        }
                    }
                } else if let Some(raw_token) = line.strip_prefix("BMO_SERVER_TOKEN=") {
                    if let Ok(mut target) = app.state::<SidecarState>().token.lock() {
                        *target = Some(raw_token.trim().to_string());
                    }
                }
            }
        });
    }

    Ok(())
}

#[cfg(debug_assertions)]
fn sidecar_command(_app: &tauri::AppHandle) -> tauri::Result<Command> {
    let mut command = Command::new("pnpm");
    command
        .args(["--filter", "@bmo/server", "dev", "--", "--port=0"])
        .current_dir(workspace_root());
    Ok(command)
}

#[cfg(not(debug_assertions))]
fn sidecar_command(_app: &tauri::AppHandle) -> tauri::Result<Command> {
    if let Ok(binary) = std::env::var("BMO_SERVER_BIN") {
        let mut command = Command::new(PathBuf::from(binary));
        command.arg("--port=0");
        return Ok(command);
    }

    let resource_dir = _app.path().resource_dir()?;
    let sidecar_dir = resource_dir.join("sidecar");
    let node = sidecar_dir
        .join("node")
        .join("bin")
        .join(format!("node{}", std::env::consts::EXE_SUFFIX));
    let entrypoint = sidecar_dir.join("server").join("dist").join("index.js");

    let mut command = Command::new(node);
    command.arg(entrypoint);
    command.arg("--port=0");
    command.current_dir(sidecar_dir.join("server"));
    Ok(command)
}

fn kill_sidecar(app: &tauri::AppHandle) {
    let state = app.state::<SidecarState>();
    let child = if let Ok(mut slot) = state.child.lock() {
        slot.take()
    } else {
        None
    };

    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(debug_assertions)]
fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
