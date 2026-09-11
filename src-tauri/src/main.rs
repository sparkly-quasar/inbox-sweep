// Prevents a console window from appearing alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    inbox_sweep_lib::run()
}
