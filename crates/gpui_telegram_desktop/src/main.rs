use gpui::*;
use gpui_telegram_client::{ClientConfig, TelegramClient};
use gpui_telegram_desktop::browser_bridge::{
    global_desktop_browser_bridge, run_headless_browser_bridge_daemon,
    DesktopBrowserBridgeStartOptions,
};
use gpui_telegram_desktop::theme::TelegramAssetSource;
use gpui_telegram_desktop::views::AppShell;
use std::sync::Arc;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V" || a == "-v") {
        println!("Fabushi Desktop v{}", env!("CARGO_PKG_VERSION"));
        println!("gpui_telegram_desktop {}", env!("CARGO_PKG_VERSION"));
        std::process::exit(0);
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("Fabushi Desktop Client");
        println!("Version: {}", env!("CARGO_PKG_VERSION"));
        println!();
        println!("USAGE:");
        println!("    gpui_telegram_desktop [OPTIONS]");
        println!();
        println!("OPTIONS:");
        println!("    -s, --server-url <URL>        Set the remote server URL");
        println!("        --browser-bridge-only     Run headless Browser Control loopback bridge daemon");
        println!("        --browser-bridge-port <P> Set loopback bridge port (default: 19222)");
        println!("    -h, --help                    Print help information");
        println!("    -V, --version                 Print version information");
        std::process::exit(0);
    }

    if args.iter().any(|a| a == "--browser-bridge-only") {
        if let Err(err) = run_headless_browser_bridge_daemon(&args) {
            eprintln!("[Fabushi Desktop Bridge] Fatal error: {err}");
            std::process::exit(1);
        }
        return;
    }

    let config = ClientConfig::resolve_with_args(&args);
    println!(
        "[Fabushi] Resolved Server URL: {} (Source: {:?})",
        config.server_url, config.config_source
    );

    let cache_dir = ClientConfig::get_app_dir();
    let client = Arc::new(
        TelegramClient::open_with_dir(config.clone(), cache_dir)
            .unwrap_or_else(|_| TelegramClient::new(config.clone())),
    );
    let _tokio_guard = client.runtime().enter();

    // Launch embedded loopback Browser Control Bridge in background and wire Desktop's HermesEngine
    {
        let bridge = Arc::clone(global_desktop_browser_bridge());
        let _ = bridge.local_hermes_engine();
        let bridge_opts = DesktopBrowserBridgeStartOptions::from_env_and_args(&args);
        let server_url = config.server_url.clone();
        let saved_token = ClientConfig::load_session().map(|s| s.token);
        client.runtime().spawn(async move {
            match bridge.start_loopback_server(bridge_opts).await {
                Ok(port) => {
                    println!(
                        "[Fabushi] Desktop Browser Control Bridge listening on 127.0.0.1:{port}"
                    );
                }
                Err(err) => {
                    eprintln!("[Fabushi] Desktop Browser Control Bridge startup warning: {err}");
                }
            }
            if saved_token.is_some() {
                bridge.connect_upstream_server(server_url, saved_token);
            }
        });
    }

    Application::new()
        .with_assets(TelegramAssetSource::new())
        .run(move |cx: &mut App| {
            cx.activate(true);
            let bounds = Bounds::centered(None, size(px(1280.0), px(820.0)), cx);
            let app_client = client.clone();

            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(TitlebarOptions {
                        title: Some(SharedString::from("")),
                        ..Default::default()
                    }),
                    focus: true,
                    show: true,
                    window_min_size: Some(size(px(800.0), px(560.0))),
                    ..Default::default()
                },
                |window, cx| {
                    window.activate_window();
                    cx.new(|cx| AppShell::new_with_client(app_client, cx))
                },
            )
            .expect("Failed to open main window");
            cx.activate(true);
        });
}
