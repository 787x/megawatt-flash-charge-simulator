"use strict";

const { app, BrowserWindow, dialog } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = 17823;
const HOST = "127.0.0.1";
const ORIGIN = `http://${HOST}:${PORT}`;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function getWebRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "web");
  }
  return path.join(__dirname, "..", "dist-static");
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

function createServer(webRoot) {
  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url);
    let pathname = decodeURIComponent(parsed.pathname);

    // Root → index.html
    if (pathname === "/") {
      pathname = "/index.html";
    }

    // Resolve to web root and prevent traversal
    const filePath = path.join(webRoot, pathname);
    const resolvedRoot = path.resolve(webRoot);
    const resolvedFile = path.resolve(filePath);
    const relative = path.relative(resolvedRoot, resolvedFile);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("403 Forbidden");
      return;
    }

    fs.stat(resolvedFile, (err, stats) => {
      if (err || !stats.isFile()) {
        // For paths without extension (document navigation), fallback to index.html
        const ext = path.extname(pathname);
        if (!ext) {
          const indexPath = path.join(webRoot, "index.html");
          fs.readFile(indexPath, (indexErr, data) => {
            if (indexErr) {
              res.writeHead(404, { "Content-Type": "text/plain" });
              res.end("404 Not Found");
              return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(data);
          });
          return;
        }
        // Asset with extension not found → 404
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
        return;
      }

      const contentType = getMimeType(resolvedFile);
      fs.readFile(resolvedFile, (readErr, data) => {
        if (readErr) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("500 Internal Server Error");
          return;
        }
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
      });
    });
  });

  return server;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 360,
    minHeight: 640,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL(ORIGIN);
  return win;
}

// Single instance lock
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  let mainWindow = null;
  let server = null;

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const webRoot = getWebRoot();

    // Verify web root exists
    if (!fs.existsSync(path.join(webRoot, "index.html"))) {
      dialog.showErrorBox(
        "启动错误",
        `找不到网页资源：\n${webRoot}\n\n请确认 dist-static 已构建。`
      );
      app.quit();
      return;
    }

    server = createServer(webRoot);

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        dialog.showErrorBox(
          "端口占用",
          `端口 ${PORT} 已被占用。\n\n本应用需要固定端口 ${PORT} 以保持数据持久化。\n请关闭占用该端口的程序后重试。`
        );
        app.quit();
      } else {
        dialog.showErrorBox("服务器错误", err.message);
        app.quit();
      }
    });

    server.listen(PORT, HOST, () => {
      mainWindow = createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (server) {
      server.close();
      server = null;
    }
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
}
