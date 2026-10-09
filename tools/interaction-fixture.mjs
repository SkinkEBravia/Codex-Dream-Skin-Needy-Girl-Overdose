// Public synthetic content only. This exercises skin selectors; it is not a
// React/ProseMirror replica and does not establish native-app input latency.
export const FIXTURE_PARAMETERS = Object.freeze({ revision: "interaction-fixture/1",
  viewport: Object.freeze({ width: 1200, height: 800 }), messages: 160,
  messageDepth: 16, textRepeats: 16, sidebarRows: 120, retainedPages: 2,
  typingCharacters: 200, typingCadenceMs: 40, firstKeyIdleMs: 1000,
  scrollInputs: 5, scrollPixels: 240, scrollCadenceMs: 100 });

export function fixtureHtml({ slowInputMs = 0 } = {}) {
  if (!Number.isInteger(slowInputMs) || slowInputMs < 0 || slowInputMs > 200) throw new Error("Invalid induced input delay");
  const p = FIXTURE_PARAMETERS;
  const message = '<article data-message-author-role="assistant"><div>'.repeat(1)
    + '<div data-fixture-wrapper>'.repeat(p.messageDepth)
    + '<p>Synthetic ordinary assistant output. '.repeat(p.textRepeats) + '</p>'.repeat(p.textRepeats)
    + '</div>'.repeat(p.messageDepth) + '</div></article>';
  const pages = Array.from({ length: p.retainedPages }, (_, i) =>
    `<section data-fixture-page="${i ? "B" : "A"}" data-app-shell-active-page="${i ? "false" : "true"}" ${i ? 'hidden inert aria-hidden="true"' : ''}><div class="thread-scroll-container" data-fixture-transcript>${message.repeat(p.messages)}</div></section>`).join("");
  const rows = Array.from({ length: p.sidebarRows }, (_, i) => `<button data-fixture-dock-row>Fixture project ${i}</button>`).join("");
  return `<!doctype html><html class="dark"><head><meta charset="utf-8"><style>
    :root{color-scheme:dark;--color-background:#181818;--color-foreground:#eee;--color-token-text-primary:#eee}
    html.light{color-scheme:light;--color-background:#fafafa;--color-foreground:#222;--color-token-text-primary:#222}
    *{box-sizing:border-box}body{margin:0;font:14px system-ui;background:var(--color-background);color:var(--color-foreground)}
    header{position:relative;height:48px;display:flex;gap:20px;align-items:center;padding:8px}
    #fixture-shell{display:flex;height:752px}aside.app-shell-left-panel{width:240px;flex:none;overflow:hidden}
    [data-app-action-sidebar-scroll]{height:690px;overflow:auto;scroll-behavior:auto}
    [data-fixture-dock-row]{display:block;height:42px;width:220px;color:inherit;background:transparent;border:0;text-align:left}
    main.main-surface{position:relative;display:flex;flex:1;min-width:0;overflow:hidden}
    #fixture-thread{flex:1;min-width:0;display:flex;flex-direction:column}section[data-fixture-page]{height:580px;min-height:580px}
    [hidden]{display:none!important}.thread-scroll-container{height:100%;overflow:auto;scroll-behavior:auto;padding:12px}
    article{margin:12px 0;min-height:70px}.composer-surface-chrome{height:145px;margin:8px;padding:10px;border:1px solid #666;border-radius:16px}
    #benchmark-editor{min-height:70px;max-height:90px;overflow:auto;white-space:pre-wrap;outline:0}
    #fixture-changes{width:280px;flex:none;overflow:hidden}#fixture-changes [data-app-action-review-scroll]{height:680px;overflow:auto}
    .review-header{height:42px}.fixture-file{height:95px;border-bottom:1px solid #777}.text-codex-git-added{color:#1ec850}.text-codex-git-deleted{color:#f55}
    button{color:inherit}#portals{position:fixed;inset:0;pointer-events:none}
  </style></head><body><header class="app-header-tint"><button id="fixture-switch">Switch fixture session</button><button id="fixture-appearance">Toggle appearance</button></header>
    <div id="fixture-shell"><aside class="app-shell-left-panel"><div data-app-action-sidebar-scroll>${rows}</div></aside>
      <main class="main-surface" data-app-shell-main-surface><div id="fixture-thread">${pages}
        <form class="composer-surface-chrome" data-composer-surface-variant="default" data-composer-radius-variant="default"><div id="benchmark-editor" class="ProseMirror" contenteditable="true" role="textbox" aria-label="Synthetic benchmark editor"></div><div data-composer-footer-responsive><button type="button">Attach</button><button type="button">Synthetic send control</button></div></form>
      </div><div role="tabpanel" id="fixture-changes"><div class="@container/review-header review-header"><div role="group"><button>Last turn</button><span class="text-codex-git-added">+44</span><span class="text-codex-git-deleted">-3</span></div></div><div data-app-action-review-scroll>${'<div data-review-path="public-fixture.js" class="fixture-file"><button data-app-action-review-file-toggle aria-expanded="false">Public fixture file</button></div>'.repeat(20)}</div></div></main>
    </div><div id="portals"></div><script>
      (()=>{const editor=document.getElementById('benchmark-editor');let active='A';let inputCount=0;let switchCount=0;let appearanceCount=0;
        const switchPage=()=>{active=active==='A'?'B':'A';for(const page of document.querySelectorAll('[data-fixture-page]')){const enabled=page.dataset.fixturePage===active;page.hidden=!enabled;page.inert=!enabled;page.setAttribute('aria-hidden',String(!enabled));page.setAttribute('data-app-shell-active-page',String(enabled));}editor.replaceChildren();switchCount++;};
        document.getElementById('fixture-switch').addEventListener('click',switchPage);
        document.getElementById('fixture-appearance').addEventListener('click',()=>{const light=!document.documentElement.classList.contains('light');document.documentElement.classList.toggle('light',light);document.documentElement.classList.toggle('dark',!light);document.documentElement.style.colorScheme=light?'light':'dark';appearanceCount++;});
        editor.addEventListener('input',()=>{inputCount++;const end=performance.now()+${slowInputMs};while(performance.now()<end){};editor.closest('form').classList.toggle('fixture-has-input',!!editor.textContent);});
        document.querySelector('form').addEventListener('submit',event=>event.preventDefault());
        window.__DREAM_SKIN_FIXTURE__={switchPage,ready:()=>document.visibilityState==='visible'&&!!editor.isConnected&&!!document.querySelector('[data-app-shell-active-page="true"]'),state:()=>({active,inputCount,switchCount,appearanceCount,editorLength:editor.textContent.length}),resetEditor:()=>editor.replaceChildren(),domMutation:()=>editor.appendChild(document.createTextNode('x')),syntheticComposition:()=>{editor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));editor.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'x'}));editor.appendChild(document.createTextNode('x'));editor.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'x'}));editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'x',isComposing:false}));}};
      })();
    </script></body></html>`;
}
