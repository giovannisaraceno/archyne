/*
 * Archyne workspace bridge. Plain JS, served by the workspace server as
 * /__archyne/bridge.js and loaded after an inline script that sets
 * globalThis.__archyneWorkspace = { token, root, autosave }.
 *
 * It defines globalThis.archyne as a DesktopBridge over the /__archyne/ API.
 * Toward the app every path is absolute (root + relative); toward the API it
 * is relative to root. setTheme, fetchIcons and ai are deliberately absent.
 */
(function () {
  "use strict";
  var cfg = globalThis.__archyneWorkspace;
  if (!cfg || typeof cfg.root !== "string") return;

  var MAX_AUTO = 5;
  var POLL_MS = 2000;
  var STORE_KEY = "graph:workspace";
  var root = cfg.root.replace(/\/+$/, "");
  var token = cfg.token || "";

  function toAbs(rel) {
    return root + "/" + rel;
  }
  function toRel(p) {
    if (p.indexOf(root + "/") === 0) return p.slice(root.length + 1);
    return p;
  }
  function hasExt(p) {
    return /\.(mmd|mermaid)$/i.test(p);
  }

  function request(method, path, params, body) {
    var qs = new URLSearchParams(params || {}).toString();
    var init = { method: method, headers: { "X-Archyne-Token": token } };
    if (body !== undefined) {
      init.body = body;
      init.headers["Content-Type"] = "text/plain; charset=utf-8";
    }
    return fetch("/__archyne/" + path + (qs ? "?" + qs : ""), init);
  }
  function fail(res, what) {
    var err = new Error(what + " failed (" + res.status + ")");
    err.status = res.status;
    if (res.status === 409) err.code = "conflict";
    return err;
  }

  function list() {
    return request("GET", "list").then(function (res) {
      if (!res.ok) throw fail(res, "list");
      return res.json().then(function (j) {
        return (j.files || []).map(function (f) {
          return f.path;
        });
      });
    });
  }
  function load(rel) {
    return request("GET", "file", { path: rel }).then(function (res) {
      if (res.status === 404) return null;
      if (!res.ok) throw fail(res, "read");
      return res.json().then(function (j) {
        return { path: toAbs(rel), content: j.content };
      });
    });
  }

  function notice(text) {
    try {
      var el = document.createElement("div");
      el.setAttribute("role", "status");
      el.setAttribute("data-archyne-notice", "");
      el.textContent = text;
      el.style.cssText =
        "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
        "background:#222;color:#fff;padding:8px 14px;border-radius:6px;font:13px system-ui,sans-serif";
      document.body.appendChild(el);
      setTimeout(function () {
        el.remove();
      }, 6000);
    } catch (e) {
      /* no DOM, nothing to tell */
    }
  }

  /** Resolves with the selected relative paths, or null for "Empty tab". */
  function chooser(files, preselected) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.setAttribute("data-archyne-dialog", "");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center";
      var box = document.createElement("div");
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.style.cssText =
        "background:#fff;color:#111;border-radius:8px;padding:16px;max-width:480px;width:90%;max-height:80vh;display:flex;flex-direction:column;gap:12px;font:14px system-ui,sans-serif";
      var title = document.createElement("strong");
      title.textContent = "Choose diagrams to open";
      var listEl = document.createElement("div");
      listEl.style.cssText = "overflow:auto;display:flex;flex-direction:column;gap:4px";
      var boxes = [];
      files.forEach(function (rel) {
        var label = document.createElement("label");
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = rel;
        cb.checked = rel === preselected;
        boxes.push(cb);
        label.appendChild(cb);
        label.appendChild(document.createTextNode(" " + rel));
        listEl.appendChild(label);
      });
      var actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
      function done(value) {
        overlay.remove();
        resolve(value);
      }
      var empty = document.createElement("button");
      empty.type = "button";
      empty.textContent = "Empty tab";
      empty.addEventListener("click", function () {
        done(null);
      });
      var open = document.createElement("button");
      open.type = "button";
      open.textContent = "Open selected";
      open.addEventListener("click", function () {
        done(
          boxes
            .filter(function (b) {
              return b.checked;
            })
            .map(function (b) {
              return b.value;
            }),
        );
      });
      actions.appendChild(empty);
      actions.appendChild(open);
      box.appendChild(title);
      box.appendChild(listEl);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
  }

  function hasTabsUnderRoot() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      var docs = (JSON.parse(raw) || {}).docs;
      return (
        Array.isArray(docs) &&
        docs.some(function (d) {
          return d && typeof d.path === "string" && d.path.indexOf(root + "/") === 0;
        })
      );
    } catch (e) {
      return false;
    }
  }

  var seen = new Set();
  var callbacks = [];
  var startup = null;
  var pollTimer = null;
  var subscribed = false;
  var polling = false;

  function deliver(rels) {
    return Promise.all(rels.map(load)).then(function (files) {
      files.forEach(function (f) {
        if (!f) return;
        callbacks.forEach(function (cb) {
          cb(f);
        });
      });
    });
  }

  // Resolves { opened: DesktopFile | null, rest: string[] }.
  function start() {
    if (startup) return startup;
    var target = new URLSearchParams(globalThis.location ? globalThis.location.search : "").get(
      "file",
    );
    startup = list()
      .then(function (files) {
        files.forEach(function (f) {
          seen.add(f);
        });
        var exists = target !== null && files.indexOf(target) >= 0;
        if (target !== null && !exists) notice("File not found: " + target);
        var first = exists ? target : files[0];
        if (hasTabsUnderRoot()) {
          return { opened: exists ? target : null, rest: [] };
        }
        if (files.length <= MAX_AUTO) {
          return {
            opened: first === undefined ? null : first,
            rest: files.filter(function (f) {
              return f !== first;
            }),
          };
        }
        return chooser(files, exists ? target : null).then(function (sel) {
          if (!sel || sel.length === 0) return { opened: null, rest: [] };
          var head = sel.indexOf(target) >= 0 ? target : sel[0];
          return {
            opened: head,
            rest: sel.filter(function (f) {
              return f !== head;
            }),
          };
        });
      })
      .then(function (r) {
        return (r.opened === null ? Promise.resolve(null) : load(r.opened)).then(
          function (file) {
            return { opened: file, rest: r.rest };
          },
        );
      })
      .catch(function (e) {
        notice("Workspace startup failed: " + (e && e.message));
        return { opened: null, rest: [] };
      });
    return startup;
  }

  function poll() {
    if (polling) return;
    polling = true;
    list()
      .then(function (files) {
        var fresh = files.filter(function (f) {
          return !seen.has(f);
        });
        fresh.forEach(function (f) {
          seen.add(f);
        });
        return deliver(fresh);
      })
      .catch(function () {
        /* try again on the next tick */
      })
      .then(function () {
        polling = false;
      });
  }

  function save(rel, content, base) {
    var params = { path: rel };
    if (base !== undefined && base !== null) params.base = String(base);
    return request("PUT", "file", params, content).then(function (res) {
      if (!res.ok) throw fail(res, "write");
      return res.json();
    });
  }

  globalThis.archyne = {
    workspace: { root: root, autosave: !!cfg.autosave },

    openedFile: function () {
      return start().then(function (s) {
        return s.opened;
      });
    },

    onOpenFile: function (cb) {
      callbacks.push(cb);
      if (subscribed) return;
      subscribed = true;
      start().then(function (s) {
        deliver(s.rest);
        pollTimer = setInterval(poll, POLL_MS);
      });
    },

    showOpen: function () {
      return list().then(function (files) {
        return chooser(files, null).then(function (sel) {
          if (!sel || sel.length === 0) return null;
          return load(sel[0]);
        });
      });
    },

    showSave: function (name, content) {
      var answer = prompt("Save as (path relative to " + root + ")", name);
      if (answer === null || answer === undefined) return Promise.resolve(null);
      var rel = toRel(String(answer).trim());
      if (!hasExt(rel)) {
        return Promise.reject(new Error("Only .mmd and .mermaid files can be saved"));
      }
      return save(rel, content).then(function () {
        return toAbs(rel);
      });
    },

    writeFile: function (path, content, opts) {
      return save(toRel(path), content, opts && opts.base).then(function (j) {
        return { mtimeMs: j.mtimeMs };
      });
    },

    statFile: function (path) {
      return request("GET", "stat", { path: toRel(path) }).then(function (res) {
        if (res.status === 404) return null;
        if (!res.ok) throw fail(res, "stat");
        return res.json().then(function (j) {
          return { mtimeMs: j.mtimeMs };
        });
      });
    },

    readFile: function (path) {
      return request("GET", "file", { path: toRel(path) }).then(function (res) {
        if (res.status === 404) return null;
        if (!res.ok) throw fail(res, "read");
        return res.json().then(function (j) {
          return j.content;
        });
      });
    },
  };
})();
