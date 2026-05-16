const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const { exec, execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs'); 
const https = require('https'); 

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

let mainWindow;
let kassa2Window = null; 
let kioskLocked = true;
let activeExternalAppExe = null; 
let isAdminPanelOpen = false; 
let runningTabs = [];

// 🚀 HƏM HTML, HƏM JS ÜÇÜN 100% RƏSMİ REAL GÜNCƏLLƏMƏ LİNKƏRİ:
const HTML_UPDATE_URL = "https://raw.githubusercontent.com/TuralHT/hts-kiosk/refs/heads/main/index.html";
const JS_UPDATE_URL   = "https://raw.githubusercontent.com/TuralHT/hts-kiosk/refs/heads/main/index.js";

// 🚀 TOQQUŞMANI VƏ BULUD BLOKLAMASINI TAMAMİLƏ ARADAN QALDIRAN ARDICIL GÜNCƏLLƏMƏ
function checkForUpdates() {
    // 1) İlk öncə təhlükəsiz şəkildə HTML faylını çağıraqlıq
    https.get(HTML_UPDATE_URL, (res) => {
        if (res.statusCode === 200) {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (body.trim().length > 0 && body.includes('<!DOCTYPE html>')) {
                    fs.writeFile(path.join(__dirname, 'index.html'), body, 'utf8', () => {
                        
                        // 🚀 KRİTİK SƏTİR: HTML diskin içinə 100% rəsmi yazılandan SONRA, 
                        // dərhal ardınca index.js-in yenilənməsini asinxron başladırıq! (Toqquşma ehtimalı 0-a düşür)
                        https.get(JS_UPDATE_URL, (jsRes) => {
                            if (jsRes.statusCode === 200) {
                                let jsBody = '';
                                jsRes.on('data', (jsChunk) => { jsBody += jsChunk; });
                                jsRes.on('end', () => {
                                    if (jsBody.trim().length > 0 && jsBody.includes('require(')) {
                                        fs.writeFile(path.join(__dirname, 'index.js'), jsBody, 'utf8', () => {
                                            console.log("Mühərrik (index.js) arxa fonda uğurla güncəlləndi!");
                                        });
                                    }
                                });
                            }
                        }).on('error', () => {});

                    });
                }
            });
        }
    }).on('error', () => {});
}


function cleanLegacyRegistry(callback) {
    exec('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" /v DisabledHotkeys /f', () => {
        exec('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v DisableTaskMgr /t REG_DWORD /d 0 /f', () => {
            if (callback) callback();
        });
    });
}

function applySystemRestrictions() {
    exec('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" /v DisabledHotkeys /t REG_SZ /d "ABCDEFGHIJKLMNOPQRSTUVWXYZ" /f');
    exec('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v DisableTaskMgr /t REG_DWORD /d 1 /f');
    exec('taskkill /f /im explorer.exe');
}

function restoreSystemSettings() {
    exec('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" /v DisabledHotkeys /f');
    exec('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v DisableTaskMgr /t REG_DWORD /d 0 /f', () => {
        exec('start explorer.exe');
    });
}

function createWindow() {
    const mainScreen = screen.getPrimaryDisplay();
    const { width, height } = mainScreen.bounds; 
    
    mainWindow = new BrowserWindow({
        x: 0,
        y: 0,
        width: width,
        height: height,
        kiosk: true, 
        fullscreen: true,
        frame: false,
        autoHideMenuBar: true,
        alwaysOnTop: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        type: 'window', 
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false
        }
    });
    
    mainWindow.maximize(); 
    mainWindow.setBounds({ x: 0, y: 0, width: width, height: height });
    
    mainWindow.loadFile('index.html');
    mainWindow.setMenuBarVisibility(false);
    mainWindow.removeMenu();
    mainWindow.webContents.setFrameRate(60);

    // 🚀 SƏSSİZ BULUD GÜNCƏLLƏMƏSİ BURADAN TETİKLƏNİR
    checkForUpdates();

    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        const responseHeaders = details.responseHeaders;
        ['X-Frame-Options', 'Content-Security-Policy', 'x-frame-options', 'content-security-policy'].forEach(header => {
            if (responseHeaders[header]) delete responseHeaders[header];
        });
        callback({ cancel: false, responseHeaders });
    });

    setInterval(() => {
        if (mainWindow && kioskLocked) {
            exec('ping 8.8.8.8 -n 1 -w 1000', (err, stdout) => {
                const isOnline = !err && stdout.includes('TTL=');
                if (mainWindow && mainWindow.webContents) {
                    mainWindow.webContents.send('network-status-update', isOnline);
                }
            });
        }
    }, 2000);

    setInterval(() => {
        if (!mainWindow || !kioskLocked || runningTabs.length === 0) return;
        
        runningTabs.forEach((tab) => {
            const baseName = tab.exeName.replace('.exe', '');
            exec(`tasklist /fi "IMAGENAME eq ${baseName}.exe"`, (err, stdout) => {
                if (stdout && (stdout.toLowerCase().includes('no tasks') || !stdout.includes(baseName))) {
                    runningTabs = runningTabs.filter(t => t.exeName !== tab.exeName);
                    if (activeExternalAppExe === tab.exeName) activeExternalAppExe = null;
                    if (mainWindow && mainWindow.webContents) {
                        mainWindow.webContents.send('app-closed-by-system', tab.exeName);
                    }
                }
            });
        });
    }, 2000);

    cleanLegacyRegistry(() => {
        setTimeout(() => { applySystemRestrictions(); }, 500);
    });

    mainWindow.on('close', (e) => { e.preventDefault(); });

    mainWindow.on('focus', () => {
        if (!kioskLocked || !mainWindow || isAdminPanelOpen) return;
        
        if (kassa2Window && kassa2Window.isMinimized()) {
            mainWindow.setAlwaysOnTop(true);
            return;
        }

        if (activeExternalAppExe) {
            const baseName = activeExternalAppExe.replace('.exe', '');
            const psCheckMinimize = `powershell -Command "` +
                `$member = '[DllImport(\\"user32.dll\\")] public static extern bool IsIconic(IntPtr hWnd);'; ` +
                `Add-Type -MemberDefinition $member -Name 'Win32Util' -Namespace 'Win32'; ` +
                `$proc = Get-Process -Name '${baseName}' -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
                `if ($proc) { ` +
                `  $isMin = [Win32.Win32Util]::IsIconic($proc.MainWindowHandle); ` +
                `  if ($isMin) { echo 'minimized' } else { echo 'visible' } ` +
                `}"`;

            exec(psCheckMinimize, (err, stdout) => {
                const status = (stdout || '').trim();
                if (status === 'visible') {
                    mainWindow.setAlwaysOnTop(false);
                    bringAppToFrontAndMaximize(activeExternalAppExe);
                } else if (status === 'minimized') {
                    mainWindow.setAlwaysOnTop(true);
                }
            });
        } else if (!kassa2Window) {
            mainWindow.setAlwaysOnTop(true);
        }
    });

    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (!kioskLocked) return;
        const key = (input.key || '').toLowerCase();
        if (!input.control && !input.alt && !input.meta && key !== 'f11' && key !== 'f4') return;
        if (
            (input.alt && key === 'f4') || 
            (input.control && key === 'escape') || 
            (input.control && key === 'r') || 
            (input.control && key === 'w') || 
            key === 'f11' || 
            input.meta
        ) {
            event.preventDefault();
        }
    });
}

function openKassa2Window() {
    if (kassa2Window) {
        kassa2Window.show();
        kassa2Window.focus();
        return;
    }

    const mainScreen = screen.getPrimaryDisplay();
    const { width, height } = mainScreen.bounds;

    if (mainWindow) mainWindow.setAlwaysOnTop(false);

    kassa2Window = new BrowserWindow({
        width: Math.floor(width * 0.85),
        height: Math.floor(height * 0.85),
        frame: true, 
        autoHideMenuBar: true,
        alwaysOnTop: true, 
        title: "HTS KIOSK · KURMARKET MODULU",
        tabbingIdentifier: 'hts-kassa2-unique-window-system', 
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
            partition: 'persist:kassa2_session'
        }
    });

    kassa2Window.center();
    kassa2Window.loadURL("https://kurmarket.azlike.work/");

    kassa2Window.on('minimize', (e) => {
        e.preventDefault(); 
        kassa2Window.setAlwaysOnTop(false); 
        kassa2Window.hide(); 
        if (mainWindow) {
            mainWindow.webContents.send('kassa2-state', 'minimized');
            mainWindow.setAlwaysOnTop(true);
        }
    });

    kassa2Window.on('focus', () => {
        if (mainWindow) {
            mainWindow.webContents.send('kassa2-state', 'visible');
            mainWindow.setAlwaysOnTop(false); 
        }
        kassa2Window.setAlwaysOnTop(true);
    });

    kassa2Window.on('closed', () => {
        kassa2Window = null;
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('kassa2-state', 'closed');
        if (mainWindow && !activeExternalAppExe) mainWindow.setAlwaysOnTop(true);
    });
}

function bringAppToFrontAndMaximize(exeName) {
    const baseName = exeName.replace('.exe', '');
    const psCommand = `powershell -Command "` +
        `$member = '[DllImport(\\"user32.dll\\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);` +
        `[DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr hWnd);'; ` +
        `$type = Add-Type -MemberDefinition $member -Name 'Win32Util' -Namespace 'Win32' -PassThru; ` +
        `$proc = Get-Process -Name '${baseName}' -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
        `if ($proc) { ` +
        `    $hWnd = $proc.MainWindowHandle; ` +
        `    if ($hWnd -ne [IntPtr]::Zero) { ` +
        `        $type::ShowWindowAsync($hWnd, 3); ` + 
        `        $type::SetForegroundWindow($hWnd); ` +
        `    } ` +
        `}"`;
    exec(psCommand);
}

ipcMain.on('close-specific-app', (event, exeName) => {
    if (exeName === 'Kassa 2') {
        if (kassa2Window) kassa2Window.close();
        return;
    }
    exec(`taskkill /f /im ${exeName}`, () => {
        runningTabs = runningTabs.filter(t => t.exeName !== exeName);
        if (activeExternalAppExe === exeName) activeExternalAppExe = null;
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('app-closed-by-system', exeName);
        }
    });
});

app.whenReady().then(() => {
    createWindow();
    globalShortcut.register('Alt+F4', () => {});
    globalShortcut.register('CommandOrControl+R', () => {});
    globalShortcut.register('CommandOrControl+W', () => {});
    globalShortcut.register('CommandOrControl+Escape', () => {});
});

app.on('window-all-closed', (e) => { e.preventDefault(); });
app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    restoreSystemSettings();
});

ipcMain.on('open-app', (event, appPath) => {
    if (!mainWindow || !kioskLocked) return;
    const cleanPath = (appPath || '').trim();
    if (cleanPath === 'CHECK_FOCUS' || cleanPath === '') {
        isAdminPanelOpen = false;
        return;
    }

    if (cleanPath === 'Kassa 2') {
        if (kassa2Window) {
            kassa2Window.show(); 
            kassa2Window.focus();
        } else {
            openKassa2Window();
        }
        return;
    }

    const winSafePath = cleanPath.replace(/\//g, '\\');
    const exeName = path.basename(winSafePath);
    const appDir = path.dirname(winSafePath);
    let realProcessName = '';

    if (exeName.toLowerCase().includes('azlike') || exeName.toLowerCase().includes('online')) {
        realProcessName = 'javaw';
    } else if (exeName.toLowerCase().includes('anydesk')) {
        realProcessName = 'AnyDesk';
    } else {
        realProcessName = exeName.replace('.exe', '');
    }

    const finalExe = realProcessName + '.exe';

    process.nextTick(() => {
        if (realProcessName.toLowerCase() === 'anydesk') {
            activeExternalAppExe = finalExe;
            if (!runningTabs.some(t => t.exeName === finalExe)) {
                runningTabs.push({ exeName: finalExe });
            }
            if (mainWindow) mainWindow.setAlwaysOnTop(false);

            exec(`cmd.exe /c start "" "${winSafePath}"`, { cwd: appDir }, () => {
                setTimeout(() => {
                    exec(`powershell -Command "$ws = New-Object -ComObject WScript.Shell; $ws.AppActivate('AnyDesk')"`);
                    bringAppToFrontAndMaximize(finalExe); 
                }, 500); 
            });
            return;
        }

        exec(`powershell -Command "Get-Process -Name '${realProcessName}' -ErrorAction SilentlyContinue"`, (err, stdout) => {
            if (stdout && stdout.trim() !== "") {
                activeExternalAppExe = finalExe;
                if (!runningTabs.some(t => t.exeName === finalExe)) runningTabs.push({ exeName: finalExe });
                if (mainWindow) mainWindow.setAlwaysOnTop(false);
                bringAppToFrontAndMaximize(finalExe);
            } else {
                activeExternalAppExe = finalExe;
                if (!runningTabs.some(t => t.exeName === finalExe)) runningTabs.push({ exeName: finalExe });
                if (mainWindow) mainWindow.setAlwaysOnTop(false);
                execFile(winSafePath, [], { cwd: appDir }, (startErr) => {
                    if (startErr) console.error("Başlatma xətası:", startErr);
                    setTimeout(() => { bringAppToFrontAndMaximize(finalExe); }, 1200);
                });
            }
        });
    });
});

ipcMain.on('get-network-details', (event) => {
    const interfaces = os.networkInterfaces();
    let netData = { name: 'Aktiv Bağlantı', ip: '-', mac: '-' };
    for (const name in interfaces) {
        if (name.toLowerCase().includes('loopback') || name.toLowerCase().includes('vbox')) continue;
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                netData.name = name;
                netData.ip = net.address;
                netData.mac = net.mac ? net.mac.toUpperCase() : '-';
                break;
            }
        }
    }
    if (mainWindow) mainWindow.webContents.send('network-details-response', netData);
});

ipcMain.on('trigger-admin-panel', () => { isAdminPanelOpen = true; });
ipcMain.on('admin-access', () => {
    kioskLocked = false;
    if (kassa2Window) kassa2Window.close();
    restoreSystemSettings();
    if (mainWindow) {
        mainWindow.removeAllListeners('close');
        mainWindow.destroy();
    }
    setTimeout(() => { app.quit(); }, 1000);
});
