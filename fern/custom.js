(function() {
  "use strict";

  var API_BASE = "https://vzw.pm-demo.dev/api/partner/services";

  var SERVICE_MAP_URL = "https://vzw.pm-demo.dev/api/public/service-map";

  function fetchServiceMap() {
    var cached = sessionStorage.getItem("vzw_service_map");
    if (cached) {
      try {
        var parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < 5 * 60 * 1000) {
          return Promise.resolve(parsed.data);
        }
      } catch (e) {}
    }
    return fetch(SERVICE_MAP_URL)
      .then(function(res) { return res.ok ? res.json() : null; })
      .then(function(data) {
        if (data) {
          sessionStorage.setItem("vzw_service_map", JSON.stringify({ timestamp: Date.now(), data: data }));
        }
        return data;
      })
      .catch(function() { return null; });
  }

  function resolveServiceId(map) {
    if (!map) return null;
    var path = window.location.pathname.replace(/^\/+|\/+$/g, "");
    if (map[path]) return map[path];
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      if (path.indexOf(keys[i]) === 0) return map[keys[i]];
    }
    return null;
  }

  function fetchServiceData(serviceId) {
    return fetch(API_BASE + "/" + serviceId + "/live")
      .then(function(res) { return res.ok ? res.json() : null; })
      .catch(function() { return null; });
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return (str || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function buildOverviewHtml(data) {
    if (!data) {
      var sk = "skeleton-loader";
      var healthHtml = '<span class="so-health-dot"></span> <span class="' + sk + '" style="display:inline-block; width: 60px;">&nbsp;</span>';
      var urlsHtml = '<div class="so-base-url">' +
        '<span class="so-env ' + sk + '" style="min-width: 40px; margin-bottom: 0;">&nbsp;</span>' +
        '<code class="so-url ' + sk + '" style="margin-bottom: 0;">&nbsp;</code>' +
        '<button class="so-copy fern-button minimal small" disabled><span class="fern-button-content"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></span></button>' +
        '</div>';
      var actionsHtml = '<button class="fern-button outlined small ' + sk + '" style="width: 170px; border-color: transparent;"><span class="fern-button-content"><span class="fern-button-text">&nbsp;</span></span></button>';
      var depGroup = '<div class="so-dep-group"><div class="so-dep-title ' + sk + '" style="width: 120px;">&nbsp;</div><div class="so-dep-list"><span class="so-chip ' + sk + '" style="width: 140px;">&nbsp;</span><span class="so-chip ' + sk + '" style="width: 100px;">&nbsp;</span></div></div>';
      
      return '<div class="vzw-service-overview service-overview-compact">' +
        '<div class="so-header">' +
          '<div class="so-meta">' +
            '<div class="so-health offline">' + healthHtml + '</div>' +
            urlsHtml +
          '</div>' +
          '<div class="so-actions">' + actionsHtml + '</div>' +
        '</div>' +
        '<div class="so-dependencies">' + depGroup + depGroup + depGroup + '</div>' +
        '</div>';
    }

    var svc = data.service || {};
    var health = svc.health || "offline";
    var healthClass = health === "healthy" ? "healthy" : health === "degraded" ? "degraded" : "offline";
    var healthLabel = health === "healthy" ? "Healthy" : health === "degraded" ? "Degraded" : "Offline";
    var deps = data.dependencies || {};

    var urlsHtml = "";
    var envDeps = data.environment_deployments || [];
    if (envDeps.length > 0) {
      urlsHtml = envDeps.map(function(ed) {
        return '<span class="so-env">' + escapeHtml(ed.environment) + '</span>' +
          '<code class="so-url">' + escapeHtml(ed.runtime_url) + '</code>' +
          '<button class="so-copy fern-button minimal small" data-copy="' + escapeAttr(ed.runtime_url) + '" title="Copy URL">' +
          '<span class="fern-button-content"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></span>' +
          '</button>';
      }).join('</div><div class="so-base-url">');
      urlsHtml = '<div class="so-base-url">' + urlsHtml + '</div>';
    } else if (svc.entrypoint_url) {
      urlsHtml = '<div class="so-base-url"><span class="so-env">PROD</span>' +
        '<code class="so-url">' + escapeHtml(svc.entrypoint_url) + '</code>' +
        '<button class="so-copy fern-button minimal small" data-copy="' + escapeAttr(svc.entrypoint_url) + '" title="Copy URL">' +
        '<span class="fern-button-content"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></span>' +
        '</button></div>';
    } else {
      urlsHtml = '<span class="vzw-muted" style="margin-top: 6px;">Available when the service is deployed.</span>';
    }

    var actionsHtml = "";
    if (svc.agent_prompt) {
      actionsHtml += '<button class="fern-button outlined small" data-action="auto-onboard" data-prompt="' + escapeAttr(svc.agent_prompt) + '"><span class="fern-button-content"><span class="fern-button-text">Auto-Onboard in Postman</span></span></button>';
    }

    var html = '<div class="vzw-service-overview service-overview-compact">' +
      '<div class="so-header">' +
        '<div class="so-meta">' +
          '<div class="so-health ' + healthClass + '">' +
            '<span class="so-health-dot"></span> ' + healthLabel +
          '</div>' +
          urlsHtml +
        '</div>' +
        (actionsHtml ? '<div class="so-actions">' + actionsHtml + '</div>' : '') +
      '</div>';

    var upDepsHtml = buildDepsHtml("Upstream", deps.upstream || []);
    var downDepsHtml = buildDepsHtml("Downstream", deps.downstream || []);
    var consumesDepsHtml = buildDepsHtml("Runtime", deps.consumes || []);

    if (upDepsHtml || downDepsHtml || consumesDepsHtml) {
      html += '<div class="so-dependencies">' + upDepsHtml + downDepsHtml + consumesDepsHtml + '</div>';
    }

    html += '</div>';
    return html;
  }

  function buildDepsHtml(title, deps) {
    if (!deps || deps.length === 0) return "";
    var listHtml = deps.map(function(dep) {
      return '<span class="so-chip" title="' + escapeAttr(dep.title) + '">' + escapeHtml(dep.service_id) + '</span>';
    }).join("");
    return '<div class="so-dep-group">' +
      '<div class="so-dep-title">' + escapeHtml(title) + ' (' + deps.length + ')</div>' +
      '<div class="so-dep-list">' + listHtml + '</div></div>';
  }

  function injectOverview(data, isSkeleton) {
    var existing = document.querySelector(".vzw-service-overview");
    if (existing && !isSkeleton) {
      var wrapper = document.createElement("div");
      wrapper.innerHTML = buildOverviewHtml(data);
      existing.parentNode.replaceChild(wrapper.firstChild, existing);
      return;
    }
    if (existing) return;

    var target = document.querySelector("[class*='EndpointContent']") ||
                 document.querySelector("[class*='ApiPage']") ||
                 document.querySelector("[class*='api-page']") ||
                 document.querySelector("article") ||
                 document.querySelector("main");

    if (!target) return;

    var wrapper = document.createElement("div");
    wrapper.innerHTML = buildOverviewHtml(data);
    target.parentNode.insertBefore(wrapper.firstChild, target);
  }

  function showModal(prompt, workspaceUrl) {
    var existing = document.querySelector(".vzw-modal");
    if (existing) existing.remove();
    var modal = document.createElement("div");
    modal.className = "vzw-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    var wsAttr = workspaceUrl ? ' data-workspace="' + escapeAttr(workspaceUrl) + '"' : '';
    var btnLabel = workspaceUrl ? 'Copy Prompt & Open Workspace' : 'Copy Prompt';
    modal.innerHTML = '<button class="vzw-modal-backdrop" aria-label="Close modal"></button>' +
      '<div class="vzw-modal-panel">' +
        '<div class="vzw-modal-header">' +
          '<div class="vzw-modal-title-group">' +
            '<span class="vzw-modal-eyebrow">Auto-Onboard in Postman</span>' +
            '<h3 class="vzw-modal-title">Agent Prompt</h3>' +
          '</div>' +
          '<button class="vzw-modal-close" aria-label="Close">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
          '</button>' +
        '</div>' +
        '<div class="vzw-modal-body">' +
          '<p class="vzw-modal-copy">Copy this prompt into Postman Agent Mode to auto-onboard this API.</p>' +
          '<div class="vzw-prompt-container">' +
            '<textarea class="vzw-prompt-box" readonly spellcheck="false">' + escapeHtml(prompt) + '</textarea>' +
          '</div>' +
        '</div>' +
        '<div class="vzw-modal-footer">' +
          '<button class="vzw-modal-footer-btn vzw-modal-close-btn">Cancel</button>' +
          '<button class="vzw-modal-footer-btn vzw-modal-primary-btn vzw-copy-btn" data-copy="' + escapeAttr(prompt) + '"' + wsAttr + '>' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
            btnLabel +
          '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
  }

  function hideModal() {
    var modal = document.querySelector(".vzw-modal");
    if (modal) modal.remove();
  }

  document.addEventListener("click", function(e) {
    // Intercept "Run in Postman" header button
    var link = e.target.closest("a");
    if (link && link.getAttribute("href") === "https://postman.com/intercept/run") {
      e.preventDefault();
      fetchServiceMap().then(function(map) {
        var serviceId = resolveServiceId(map);
        if (serviceId) {
          var cached = sessionStorage.getItem("vzw_svc_" + serviceId);
          if (cached) {
            try {
              var data = JSON.parse(cached).data;
              if (data && data.service && data.service.run_in_postman_url) {
                window.open(data.service.run_in_postman_url, "_blank");
                return;
              }
            } catch (ex) {}
          }
          // If not cached yet, fetch and open
          fetchServiceData(serviceId).then(function(data) {
            if (data && data.service && data.service.run_in_postman_url) {
              window.open(data.service.run_in_postman_url, "_blank");
            } else {
              window.open("https://partner.vzw.pm-demo.dev", "_blank");
            }
          });
          return;
        }
        window.open("https://partner.vzw.pm-demo.dev", "_blank");
      });
      return;
    }

    // Auto-onboard button
    var btn = e.target.closest("[data-action='auto-onboard']");
    if (btn) {
      var prompt = btn.getAttribute("data-prompt") || "";
      var workspaceUrl = "";
      fetchServiceMap().then(function(map) {
        var serviceId = resolveServiceId(map);
        if (serviceId) {
          var cached = sessionStorage.getItem("vzw_svc_" + serviceId);
          if (cached) {
            try { workspaceUrl = JSON.parse(cached).data.service.run_in_postman_url || ""; } catch(ex) {}
          }
        }
        showModal(prompt, workspaceUrl);
      });
      return;
    }

    // Copy buttons
    var copyBtn = e.target.closest(".vzw-copy-btn");
    if (copyBtn) {
      var val = copyBtn.getAttribute("data-copy") || "";
      var workspaceUrl = copyBtn.getAttribute("data-workspace") || "";
      navigator.clipboard.writeText(val).then(function() {
        var orig = copyBtn.innerHTML;
        copyBtn.innerHTML = copyBtn.innerHTML.replace("Copy Prompt", "Copied!");
        setTimeout(function() { copyBtn.innerHTML = orig; }, 1200);
        if (workspaceUrl) {
          setTimeout(function() { window.open(workspaceUrl, "_blank"); }, 400);
        }
      });
      return;
    }

    // Modal dismissal
    if (e.target.closest(".vzw-modal-backdrop") || e.target.closest(".vzw-modal-close") || e.target.closest(".vzw-modal-close-btn")) {
      hideModal();
    }
  });

  var lastPath = "";

  function init() {
    var currentPath = window.location.pathname;
    if (currentPath === lastPath && document.querySelector(".vzw-service-overview")) return;
    lastPath = currentPath;

    var existing = document.querySelector(".vzw-service-overview");
    if (existing) existing.remove();

    fetchServiceMap().then(function(map) {
      var serviceId = resolveServiceId(map);
      if (!serviceId) return;

      var cacheKey = "vzw_svc_" + serviceId;
      var cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        try {
          var parsed = JSON.parse(cached);
          if (Date.now() - parsed.timestamp < 5 * 60 * 1000) {
            injectOverview(parsed.data, false);
            return;
          }
        } catch (e) {}
      }

      injectOverview(null, true);

      fetchServiceData(serviceId).then(function(data) {
        if (!data) return;
        sessionStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data: data }));
        injectOverview(data, false);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  var observer = new MutationObserver(function() {
    var currentPath = window.location.pathname;
    if (currentPath !== lastPath) {
      setTimeout(init, 50);
    } else if (!document.querySelector(".vzw-service-overview")) {
      var target = document.querySelector("[class*='EndpointContent']") ||
                   document.querySelector("[class*='ApiPage']") ||
                   document.querySelector("[class*='api-page']");
      if (target) {
        init();
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
