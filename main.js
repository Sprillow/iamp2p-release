// Modules to control application life and create native browser window
const { app, BrowserWindow, Menu, shell } = require('electron')
const spawn = require('child_process').spawn
const {
  default: installExtension,
  REACT_DEVELOPER_TOOLS,
  REDUX_DEVTOOLS,
} = require('electron-devtools-installer')
const fs = require('fs')
const path = require('path')
const kill = require('tree-kill')
const { log, logger } = require('./logger')
require('electron-context-menu')()
require('fix-path')()
require('electron-debug')({ isEnabled: true, showDevTools: false })
const { wslPath, killAllWsl } = require('./cli');

// ELECTRON
// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow
let quit = false

// THESE ARE SIMILAR, but different, than the acorn-hc and development
// veresions of these same ports
const APP_PORT = 8889 // MUST MATCH ACORN_UI config
const ADMIN_PORT = 1235 // MUST MATCH ACORN_UI config

// a special log from the conductor, specifying
// that the interfaces are ready to receive incoming
// connections
const MAGIC_READY_STRING = 'Conductor ready.'

let HOLOCHAIN_BIN = './holochain'
if (process.platform === "win32") {
  HOLOCHAIN_BIN = 'holochain-linux';
}
let LAIR_KEYSTORE_BIN = './lair-keystore'
if (process.platform === "win32") {
  LAIR_KEYSTORE_BIN = 'lair-keystore-linux';
}

/** Add Holochain bins to PATH for WSL */
const BIN_DIR = "bin";
const BIN_PATH = path.join(__dirname, BIN_DIR);
if (process.platform === "win32") {
  log('info', 'BIN_PATH = ' + BIN_PATH);
  process.env.PATH += ';' + BIN_PATH;
}

// TODO: make this based on version number?
const CONFIG_PATH = path.join(app.getPath('appData'), 'iamp2p')
const INNER_CONFIG = path.join(CONFIG_PATH, 'holochain')
const STORAGE_PATH = path.join(INNER_CONFIG, 'database')
const CONDUCTOR_CONFIG_PATH = path.join(INNER_CONFIG, 'conductor-config.yml')

if (!fs.existsSync(CONFIG_PATH)) fs.mkdirSync(CONFIG_PATH)
if (!fs.existsSync(INNER_CONFIG)) fs.mkdirSync(INNER_CONFIG)
if (!fs.existsSync(STORAGE_PATH)) fs.mkdirSync(STORAGE_PATH)
if (!fs.existsSync(CONDUCTOR_CONFIG_PATH)) fs.writeFileSync(
  CONDUCTOR_CONFIG_PATH,
  `
environment_path: ${wslPath(STORAGE_PATH)}
use_dangerous_test_keystore: false
passphrase_service:
  type: cmd
admin_interfaces:
  - driver:
      type: websocket
      port: ${ADMIN_PORT}
network:
  bootstrap_service: https://bootstrap.holo.host
  transport_pool:
    - type: proxy
      sub_transport:
        type: quic
        bind_to: kitsune-quic://0.0.0.0:0
      proxy_config:
        type: remote_proxy_client
        proxy_url: kitsune-proxy://VYgwCrh2ZCKL1lpnMM1VVUee7ks-9BkmW47C_ys4nqg/kitsune-quic/h/kitsune-proxy.harris-braun.com/p/4010/--`
)

function createWindow() {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 1000,
    icon: __dirname + `/images/iamp2p.png`,
    webPreferences: {
      nodeIntegration: true,
    },
  })

  // and load the index.html of the app.
  mainWindow.loadURL('file://' + __dirname + '/ui/index.html')

  // Open <a href='' target='_blank'> with default system browser
  mainWindow.webContents.on('new-window', function (event, url) {
    event.preventDefault()
    shell.openExternal(url)
  })

  // Open the DevTools.
  // mainWindow.webContents.openDevTools()

  // Emitted when the window is closed.
  mainWindow.on('closed', function () {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = null
  })
}

let holochain_handle
let lair_keystore_handle

async function startConductor() {

  // adapt to WSL if needed
  let lair_bin = LAIR_KEYSTORE_BIN;
  let lair_args = [];
  if (process.platform === "win32") {
    lair_bin = process.env.comspec;
    lair_args.unshift("/c", "wsl", LAIR_KEYSTORE_BIN);
  }
  lair_keystore_handle = spawn(lair_bin, lair_args, {
    cwd: __dirname,
    env: {
      ...process.env,
    }
  })
  lair_keystore_handle.stdout.on('data', (data) => {
    log('info', 'lair-keystore: ' + data.toString())
  })
  lair_keystore_handle.stderr.on('data', (data) => {
    log('error', 'lair-keystore> ' + data.toString())
  })
  lair_keystore_handle.on('exit', (_code, _signal) => {
    kill(holochain_handle.pid, function (err) {
      if (!err) {
        log('info', 'killed all holochain sub processes')
      } else {
        log('error', err)
      }
    })
    quit = true
    app.quit()
  })

  await sleep(100)

  // adapt to WSL if needed
  let holochain_bin = HOLOCHAIN_BIN;
  let holochain_args = ['-c', wslPath(CONDUCTOR_CONFIG_PATH)];
  if (process.platform === "win32") {
    holochain_bin = process.env.comspec;
    holochain_args.unshift("/c", "wsl", HOLOCHAIN_BIN);
  }
  holochain_handle = spawn(holochain_bin, holochain_args, {
    cwd: __dirname,
    env: {
      ...process.env,
      RUST_BACKTRACE: 1,
    },
  })
  holochain_handle.stderr.on('data', (data) => {
    log('error', 'holochain> ' + data.toString())
  })
  holochain_handle.on('exit', (_code, _signal) => {
    kill(lair_keystore_handle.pid, function (err) {
      if (!err) {
        log('info', 'killed all lair_keystore sub processes')
      } else {
        log('error', err)
      }
    })
    quit = true
    app.quit()
  })
  await new Promise((resolve, _reject) => {
    holochain_handle.stdout.on('data', (data) => {
      log('info', 'holochain: ' + data.toString())
      if (data.toString().indexOf(MAGIC_READY_STRING) > -1) {
        resolve()
      }
    })
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async function () {
  installExtension(REDUX_DEVTOOLS)
    .then(() => installExtension(REACT_DEVELOPER_TOOLS))
    .then((name) => console.log(`Added Extension:  ${name}`))
    .catch((err) => console.log('An error occurred: ', err))
  createWindow()
  await startConductor()
  // trigger refresh once we know
  // interfaces have booted up
  mainWindow.loadURL('file://' + __dirname + '/ui/index.html')
})

app.on('will-quit', (event) => {
  // prevents double quitting
  if (!quit) {
    event.preventDefault()
    // SIGTERM by default
  }
  kill(holochain_handle.pid, function (err) {
    if (!err) {
      log('info', 'killed all holochain sub processes')
    } else {
      log('error', err)
    }
  })
  kill(lair_keystore_handle.pid, function (err) {
    if (!err) {
      log('info', 'killed all lair_keystore sub processes')
    } else {
      log('error', err)
    }
  })

  // Make sure there is no outstanding holochain procs
  killAllWsl(LAIR_KEYSTORE_BIN);
  killAllWsl(HOLOCHAIN_BIN);
})

// Quit when all windows are closed.
app.on('window-all-closed', function () {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', function () {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) createWindow()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

const menutemplate = [
  {
    label: 'Application',
    submenu: [
      { label: 'About Application', selector: 'orderFrontStandardAboutPanel:' },
      {
        label: 'Open Config Folder',
        click: function () {
          shell.openItem(CONFIG_PATH)
        },
      },
      {
        label: 'Show Log File',
        click: function () {
          shell.showItemInFolder(logger.transports.file.file)
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        accelerator: 'Command+Q',
        click: function () {
          app.quit()
        },
      },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', selector: 'undo:' },
      { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', selector: 'redo:' },
      { type: 'separator' },
      { label: 'Cut', accelerator: 'CmdOrCtrl+X', selector: 'cut:' },
      { label: 'Copy', accelerator: 'CmdOrCtrl+C', selector: 'copy:' },
      { label: 'Paste', accelerator: 'CmdOrCtrl+V', selector: 'paste:' },
      {
        label: 'Select All',
        accelerator: 'CmdOrCtrl+A',
        selector: 'selectAll:',
      },
    ],
  },
]

Menu.setApplicationMenu(Menu.buildFromTemplate(menutemplate))

const sleep = (ms) => new Promise((resolve) => setTimeout(() => resolve(), ms))
