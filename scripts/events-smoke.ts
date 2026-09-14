import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { TwitchIrc } from '../src/main/irc'
import { setLocale } from '../src/shared/i18n'
import type { ChatEvent } from '../src/shared/types'

// Local fixtures traverse the real IRC parser, store, virtual log and message renderer.
// The review page exports that rendered DOM and the production CSS, including motion.
const locale = process.argv[2] === 'en' ? 'en' : 'fr'
setLocale(locale)
const channel = 'twichat_demo'
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, TWICHAT_LOCALE: locale, TWICHAT_TEST_DATA: resolve(tmpdir(), `twichat-events-${locale}-${process.pid}`) } })
const errors: string[] = []
const sprite = `data:image/png;base64,${(await readFile(resolve('server/demo-assets/avatar-sprite.png'))).toString('base64')}`
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1040, 1020))
  const portraits = await page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode()
    return Array.from({ length: 12 }, (_, i) => {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64
      canvas.getContext('2d')!.drawImage(image, (i % 4) * image.width / 4, Math.floor(i / 4) * image.height / 3, image.width / 4, image.height / 3, 0, 0, 64, 64)
      return canvas.toDataURL()
    })
  }, sprite)
  await app.evaluate(({ ipcMain }, portraits) => {
    ipcMain.removeHandler('rooms:profiles')
    ipcMain.handle('rooms:profiles', async (_event, channels: string[]) => channels.map(channel => ({ channel, displayName: channel, avatarUrl: portraits[Array.from(channel).reduce((sum, char) => sum + char.charCodeAt(0), 0) % portraits.length], live: false })))
    ipcMain.removeHandler('chatters:profiles')
    ipcMain.handle('chatters:profiles', async (_event, channels: string[]) => channels.map(channel => ({ channel, displayName: channel, avatarUrl: portraits[Array.from(channel).reduce((sum, char) => sum + char.charCodeAt(0), 0) % portraits.length], live: false })))
    ipcMain.removeHandler('cheermotes:twitch')
    ipcMain.handle('cheermotes:twitch', async () => [{ prefix: 'Cheer', tiers: [10000, 5000, 1000, 100, 1].map(minBits => ({ minBits, color: minBits >= 10000 ? '#ff756e' : minBits >= 5000 ? '#b9f568' : '#9ac2f0', url: `https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/animated/${minBits}/2.gif` })) }])
    ipcMain.removeHandler('account:authenticate')
    ipcMain.handle('account:authenticate', async () => 'davloire')
  }, portraits)
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  await page.locator('#anonymous-session').click()
  await page.waitForSelector('#app:not([hidden])')
  await page.locator('#welcome-add').click()
  await page.locator('#channel-input').fill(channel)
  await page.locator('#join-form button[type=submit]').click()
  await page.waitForSelector('#room-view:not([hidden])')
  if (await page.locator('#toggle-player').getAttribute('aria-pressed') === 'false') await page.locator('#toggle-player').click()
  await page.locator('#composer-login').click()
  await page.locator('.manual-auth summary').click()
  await page.locator('#token-input').fill('test-fixture')
  await page.locator('#auth-submit').click()
  await page.waitForSelector('#account-dialog:not([open])', { state: 'attached' })

  async function dispatch(events: ChatEvent[]) {
    await app.evaluate(({ BrowserWindow }, events) => BrowserWindow.getAllWindows()[0].webContents.send('chat:events', events), events)
  }
  async function publish(lines: string[]) {
    const irc = new TwitchIrc(); const events: ChatEvent[] = []
    irc.on('event', event => events.push(event))
    for (const line of lines) (irc as unknown as { handle(line: string): void }).handle(line)
    await dispatch(events)
  }
  await dispatch([{ type: 'roomstate', channel, tags: { 'room-id': '123456789', 'followers-only': '-1' } }])
  const now = () => Date.now()
  const notice = (id: string, kind: string, name: string, extra = '', body = '') => `@id=${id};msg-id=${kind};login=${name.toLowerCase()};display-name=${name};msg-param-sub-plan=1000;tmi-sent-ts=${now()}${extra} :tmi.twitch.tv USERNOTICE #${channel}${body ? ` :${body}` : ''}`
  const chat = (id: string, name: string, text: string, extra = '') => `@id=${id};display-name=${name};tmi-sent-ts=${now()}${extra} :${name.toLowerCase()}!user@user.tmi.twitch.tv PRIVMSG #${channel} :${text}`
  const scenes = [
    { id: 'subscriptions', title: 'Abonnements', detail: 'Nouvel abonnement Prime, retour après 3 mois et anniversaire de 12 mois.', lines: () => [
      chat('s0', 'FlanaDev', 'On repart pour une belle soirée !'),
      notice('newsub', 'sub', 'Hennala', ';msg-param-sub-plan=Prime'),
      chat('s1', 'Rio_Nova', 'Bienvenue Hennala 💙'),
      notice('11111111-1111-4111-8111-111111111111', 'resub', 'PixelPanda', ';msg-param-cumulative-months=3;emotes=25:0-4', 'Kappa toujours au rendez-vous, merci pour les streams !'),
      notice('anniversary', 'resub', 'ZeeLogg', ';msg-param-cumulative-months=12;msg-param-sub-plan=2000', 'Un an déjà ! Trop heureux de faire partie de cette communauté.'),
      chat('s2', 'LuneBleue', 'Joyeux subversaire ZeeLogg 🎉')
    ] },
    { id: 'announcements', title: 'Annonces & accueil', detail: 'Annonces de modération, premier message et message mis en avant.', lines: () => [
      chat('a0', 'Rio_Nova', 'On commence à quelle heure ?'),
      notice('announcement', 'announcement', 'LuneBleue', ';msg-param-color=BLUE;badges=moderator/1', 'Le tournoi commence à 20 h ! Vous pouvez encore vous inscrire : https://example.com/tournoi'),
      chat('first', 'PetitRenard', 'Salut tout le monde, première fois ici 👋', ';first-msg=1'),
      chat('a1', 'FlanaDev', 'Bienvenue PetitRenard ! Installe-toi 🧡'),
      notice('announcement2', 'announcement', 'LuneBleue', ';msg-param-color=ORANGE;badges=moderator/1', 'Petite pause de 5 minutes. On reprend juste après avec la finale !'),
      chat('highlighted', 'Digger_Dingo', 'Un grand merci aux modos pour l’organisation ce soir !', ';msg-id=highlighted-message')
    ] },
    { id: 'cheers', title: 'Cheers', detail: '100 Bits dans le fil ; mise en avant à 1 000, 5 000 et 10 000 Bits.', lines: () => [
      chat('c0', 'ZeeLogg', 'Le dernier round était incroyable'),
      chat('smallcheer', 'Hennala', 'Cheer100 pour ce clutch !', ';bits=100'),
      chat('cheer1000', 'FlanaDev', 'Cheer1000 vous avez régalé ce soir 💙', ';bits=1000'),
      chat('cheer5000', 'Rio_Nova', 'Cheer5000 on continue comme ça !', ';bits=5000'),
      chat('c1', 'PixelPanda', 'RIOOO 🔥'),
      chat('cheer10000', 'Digger_Dingo', 'Cheer10000 pour toute la communauté, merci pour ces moments.', ';bits=10000'),
      chat('c2', 'LuneBleue', 'C’est énorme, merci Digger !')
    ] },
    { id: 'loyalty', title: 'Fidélité', detail: 'Série de directs, nouveau badge Bits et anniversaire de modération.', lines: () => [
      chat('l0', 'PixelPanda', 'Les habitués sont là 👀'),
      notice('streak', 'viewermilestone', 'ZeeLogg', ';msg-param-category=watch-streak;msg-param-value=7'),
      chat('l1', 'Hennala', 'Sept sur sept, on ne manque rien !'),
      notice('bitsbadge', 'bitsbadgetier', 'Rio_Nova', ';msg-param-threshold=10000'),
      notice('modiversary', 'modiversary', 'LuneBleue', ';msg-param-months=24'),
      chat('l2', 'FlanaDev', 'Deux ans à veiller sur nous, merci Lune 🧡')
    ] },
    { id: 'raid', title: 'Arrivée du raid', detail: 'Avatar, nom de la chaîne, taille du raid et accueil dans la discussion.', lines: () => [
      chat('r0', 'ZeeLogg', 'Attendez, je crois qu’on a de la visite…'),
      notice('raid', 'raid', 'StudioNova', ';msg-param-login=studionova;msg-param-displayName=StudioNova;msg-param-viewerCount=142'),
      chat('r1', 'PetitRenard', 'RAAAID ! On vient de chez Nova 🚀'),
      chat('r2', 'FlanaDev', 'Bienvenue à toute la commu !'),
      chat('r3', 'StudioNova', 'On vous laisse entre de bonnes mains, bonne soirée 💚'),
      chat('r4', 'LuneBleue', 'Merci pour le raid Nova, installez-vous !')
    ] },
    { id: 'gifts', title: 'Abonnements offerts', detail: 'Cadeau groupé, avatars au survol, destinataire connecté et cadeau anonyme.', lines: () => [
      chat('g0', 'Hennala', 'C’est ma soirée préférée de la semaine'),
      notice('bundle', 'submysterygift', 'kvn664', ';msg-param-mass-gift-count=10'),
      chat('bot', 'StreamableRun', 'kvn664 just gifted 10 subscriptions to the community!'),
      ...['FlanaDev', 'Hennala', 'PixelPanda', 'PetitRenard', 'Juustosampyla', 'Sesenaapi', 'Rio_Nova', 'ZeeLogg', 'Digger_Dingo', 'davloire'].map((name, i) => notice(`gift${i}`, 'subgift', 'kvn664', `;msg-param-recipient-user-name=${name.toLowerCase()};msg-param-recipient-display-name=${name}`)),
      chat('g1', 'davloire', 'Oh, j’en ai reçu un ! Merci kvn 🧡'),
      notice('singlegift', 'subgift', 'LuneBleue', ';msg-param-recipient-user-name=petitrenard;msg-param-recipient-display-name=PetitRenard;msg-param-sub-plan=2000'),
      notice('anongift', 'anonsubgift', '', ';msg-param-recipient-user-name=davloire;msg-param-recipient-display-name=davloire')
    ] }
  ]
  const rendered: { id: string; title: string; detail: string; html: string; expansions: { id: string; footer: string }[] }[] = []
  for (const scene of scenes) {
    await dispatch([{ type: 'clear', channel }])
    await publish(scene.lines())
    await page.waitForFunction(() => document.querySelectorAll('#chat-log .message').length >= 4)
    await page.locator('#chat-log').evaluate(el => { (el as HTMLElement).style.width = ''; el.scrollTop = 0 })
    await page.waitForFunction(() => document.querySelector('#chat-log')!.scrollTop < 1)
    await page.waitForTimeout(1100) // Allow finite arrival motion and the batched avatar request to settle.
    if (scene.id === 'subscriptions') {
      assert.equal(await page.locator('.community-card').count(), 3)
      assert.equal(await page.locator('[data-id="11111111-1111-4111-8111-111111111111"]').count(), 0)
      assert.equal(await page.locator('[data-context-message="11111111-1111-4111-8111-111111111111"] .message-emote').getAttribute('alt'), 'Kappa')
      assert.match(await page.locator('.event-anniversary h3').innerText(), /1 (an|year)/)
      assert.equal(await page.locator('.community-avatar img').count(), 3)
      await page.locator('[data-context-message="11111111-1111-4111-8111-111111111111"]').click({ button: 'right' })
      await page.locator('#message-context-reply').click()
      assert.equal(await page.locator('#composer-reply-user').innerText(), 'PixelPanda')
      await page.locator('#composer-reply-cancel').click()
      await publish([chat('reply', 'FlanaDev', '@PixelPanda toujours fidèle !', ';reply-parent-msg-id=11111111-1111-4111-8111-111111111111;reply-parent-user-login=pixelpanda;reply-parent-display-name=PixelPanda;reply-parent-msg-body=Kappa\\stoujours\\sau\\srendez-vous')])
      await page.locator('.message-quote').click()
      assert.equal(await page.locator('[data-id="11111111-1111-4111-8111-111111111111:event"].is-revealed').count(), 1)
      await dispatch([{ type: 'clear', channel, id: 'reply' }])
      await page.locator('[data-id="11111111-1111-4111-8111-111111111111:event"]').evaluate(el => el.classList.remove('is-revealed'))
    }
    if (scene.id === 'cheers') {
      assert.equal(await page.locator('.cheer-card').count(), 3)
      assert.equal(await page.locator('.message-cheer').count(), 4)
      assert.equal(await page.locator('[data-id="smallcheer"] .cheer-card').count(), 0)
    }
    await page.mouse.move(0, 0)
    await page.keyboard.press('Escape')
    await page.locator('#chat-log').evaluate(el => { el.scrollTop = 0 })
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
      await page.locator('.conversation').screenshot({ path: resolve(artifacts, `events-${locale}-${scene.id}-${theme}.png`) })
    }
    const html = await page.locator('#chat-log .message').evaluateAll(rows => rows.map(row => row.outerHTML).join(''))
    const expansions: { id: string; footer: string }[] = []
    for (const button of await page.locator('.gift-expand:not([hidden])').all()) {
      const row = button.locator('xpath=ancestor::article')
      const id = (await row.getAttribute('data-id'))!
      await button.click()
      await page.waitForTimeout(200)
      expansions.push({ id, footer: await row.locator('.gift-recipients').evaluate(el => el.outerHTML) })
      await button.click()
    }
    rendered.push({ ...scene, html, expansions })
    await page.locator('#chat-log').evaluate(el => { (el as HTMLElement).style.width = '300px' })
    await page.waitForTimeout(150)
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('#chat-log .message')].map(el => el.getBoundingClientRect()).sort((a, b) => a.top - b.top)
      return rows.every((row, i) => !i || row.top >= rows[i - 1].bottom - 1)
    })
    assert.equal(await page.locator('.community-card,.cheer-card,.gift-card,.raid-card').evaluateAll(cards => cards.some(el => el.scrollWidth > el.clientWidth + 1)), false, `${scene.id}: no horizontal overflow`)
    await page.locator('#chat-log').screenshot({ path: resolve(artifacts, `events-${locale}-${scene.id}-narrow.png`) })
  }
  // Deletion is tested against an actual nested message, not just the presentation helper.
  await dispatch([{ type: 'clear', channel }])
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await publish([notice('reduce', 'resub', 'ZeeLogg', ';msg-param-cumulative-months=6', 'Texte qui sera supprimé'), chat('reducecheer', 'Rio_Nova', 'Cheer10000', ';bits=10000')])
  await page.locator('[data-context-message="reduce"]').waitFor()
  assert.equal(await page.locator('.community-card').evaluate(el => getComputedStyle(el).animationName), 'none')
  assert.equal(await page.locator('.cheer-gem').evaluate(el => getComputedStyle(el).animationName), 'none')
  await dispatch([{ type: 'clear', channel, id: 'reduce' }])
  await page.waitForFunction(() => !document.querySelector('[data-context-message="reduce"]'))
  assert.equal(await page.locator('.community-card').count(), 1)
  assert.deepEqual(errors, [])

  if (locale === 'fr') {
    const assets = resolve('out/renderer/assets')
    const cssName = (await readdir(assets)).find(name => name.startsWith('hydrate-') && name.endsWith('.css'))!
    let css = await readFile(resolve(assets, cssName), 'utf8')
    for (const file of (await readdir(assets)).filter(name => name.endsWith('.woff2'))) css = css.replaceAll(`./${file}`, `data:font/woff2;base64,${(await readFile(resolve(assets, file))).toString('base64')}`)
    const data = JSON.stringify(rendered).replaceAll('<', '\\u003c')
    await writeFile(resolve(artifacts, 'events-showcase.html'), `<!doctype html><html lang="fr" data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Twichat · Les événements en situation</title><style>${css}</style><style>
html,body{height:auto;min-height:100%;overflow:auto}body{font-family:'Atkinson Hyperlegible Next Variable',sans-serif;background:var(--ink);padding:32px}.review{max-width:1160px;margin:auto}.review-head{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:28px}.review h1{font-size:32px;letter-spacing:-.04em;margin:0 0 7px}.review-intro{color:var(--n72);font-size:14px;line-height:1.5;margin:0}.review-eyebrow{font-size:11px;color:var(--lime);font-weight:800;letter-spacing:.12em;margin:0 0 10px;text-transform:uppercase}.review-tools{display:flex;gap:8px;flex-wrap:wrap}.review-tools button{border:1px solid var(--line);background:var(--n25);border-radius:6px;padding:9px 13px;font-size:12px;cursor:pointer}.review-tools button:hover{background:var(--n34)}.review-layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:32px}.review-nav{display:flex;flex-direction:column;gap:5px}.review-nav button{padding:12px;border:0;border-radius:6px;background:none;color:var(--n72);font:inherit;font-size:14px;text-align:left;cursor:pointer}.review-nav button[aria-current=true]{background:var(--n28);color:var(--paper);font-weight:700}.review-nav small{display:block;color:var(--n64);font-size:12px;line-height:1.5;margin:20px 12px}.review-scene{min-width:0}.review-scene h2{font-size:18px;margin:0 0 5px}.review-detail{color:var(--n72);font-size:13px;line-height:1.5;margin:0 0 16px}.demo-window{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--ink);max-width:820px;transition:max-width 180ms ease}.demo-top{padding:14px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:9px;background:var(--n22);font-size:14px;font-weight:700}.demo-top span{color:var(--lime)}.demo-top small{margin-left:auto;font-size:10px;font-weight:400;color:var(--n64)}.demo-log{padding:10px 0 18px}.demo-log .message{position:relative;transform:none!important;will-change:auto}.demo-composer{padding:14px 22px;border-top:1px solid var(--line);background:var(--n22);font-size:12px;color:var(--n64)}.demo-window.narrow{max-width:300px}.demo-log .message-user{color:var(--n88a)}.demo-log .message-avatar img{object-fit:cover}.review-note{margin-top:14px;color:var(--n64);font-size:12px}.review-tooltip{position:fixed;z-index:10000;pointer-events:none;background:var(--paper);color:var(--ink);font-size:12px;padding:6px 10px;border-radius:5px;box-shadow:0 3px 15px #0003}.review-tooltip[hidden]{display:none}@media(max-width:760px){body{padding:20px 12px}.review-head{align-items:start;flex-direction:column}.review-layout{grid-template-columns:1fr;gap:20px}.review-nav{flex-direction:row;flex-wrap:wrap}.review-nav small{margin:5px 12px}.review h1{font-size:27px}}@media(prefers-reduced-motion:reduce){.demo-window{transition:none}}
</style><main class="review"><header class="review-head"><div><p class="review-eyebrow">Twichat · Aperçu interactif</p><h1>Quand le chat s’anime.</h1><p class="review-intro">Les événements au milieu de la conversation.<br>Rendu de l’application, événements simulés et avatars de démonstration.</p></div><div class="review-tools"><button id="theme">Passer en clair</button><button id="width">Vue étroite</button><button id="replay">Rejouer l’arrivée ↻</button></div></header><div class="review-layout"><nav class="review-nav" aria-label="Événements"></nav><section class="review-scene"><h2 id="scene-title"></h2><p class="review-detail" id="scene-detail"></p><div class="demo-window"><div class="demo-top"><span>#</span> twichat_demo <small>APERÇU</small></div><div class="demo-log" role="log" aria-label="Conversation simulée"></div><div class="demo-composer">Vous êtes connecté en tant que davloire</div></div><p class="review-note">Survolez les avatars pour lire les pseudos. Les animations respectent le réglage de réduction des mouvements.</p></section></div></main><div class="review-tooltip" hidden role="tooltip"></div><script>
const scenes=${data};const log=document.querySelector('.demo-log');const nav=document.querySelector('.review-nav');let current=0;const collapsed=new Map();
function replay(){for(const el of log.querySelectorAll('.community-card,.cheer-card,.gift-card,.raid-card')){const name=el.classList.contains('gift-card')?'gift-arriving':el.classList.contains('raid-card')?'raid-arriving':'event-arriving';el.classList.remove(name);void el.offsetWidth;el.classList.add(name)}}
function select(index){current=index;collapsed.clear();const scene=scenes[index];document.querySelector('#scene-title').textContent=scene.title;document.querySelector('#scene-detail').textContent=scene.detail;log.innerHTML=scene.html;for(const [i,b] of [...nav.querySelectorAll('button')].entries())b.setAttribute('aria-current',String(i===index));for(const el of log.querySelectorAll('.is-revealed'))el.classList.remove('is-revealed');replay()}
scenes.forEach((scene,index)=>{const b=document.createElement('button');b.textContent=scene.title;b.onclick=()=>select(index);nav.append(b)});const note=document.createElement('small');note.textContent='6 scènes · clair / sombre · largeur de 300 px · animation rejouable';nav.append(note);
document.querySelector('#theme').onclick=()=>{const light=document.documentElement.dataset.theme!=='light';document.documentElement.dataset.theme=light?'light':'dark';document.querySelector('#theme').textContent=light?'Passer en sombre':'Passer en clair'};
document.querySelector('#width').onclick=()=>{const narrow=document.querySelector('.demo-window').classList.toggle('narrow');document.querySelector('#width').textContent=narrow?'Vue normale':'Vue étroite'};document.querySelector('#replay').onclick=replay;
const tip=document.querySelector('.review-tooltip');log.addEventListener('pointerover',e=>{const node=e.target.closest('[data-card]');if(!node)return;tip.textContent=node.title||node.getAttribute('aria-label')||node.dataset.card;tip.hidden=false;const r=node.getBoundingClientRect();tip.style.left=Math.min(r.left,innerWidth-tip.offsetWidth-12)+'px';tip.style.top=Math.max(4,r.top-tip.offsetHeight-8)+'px'});log.addEventListener('pointerout',()=>tip.hidden=true);log.addEventListener('click',e=>{const button=e.target.closest('.gift-expand');if(button){const row=button.closest('.message');const footer=row.querySelector('.gift-recipients');const expansion=scenes[current].expansions.find(item=>item.id===row.dataset.id);if(expansion){if(collapsed.has(row.dataset.id)){footer.outerHTML=collapsed.get(row.dataset.id);collapsed.delete(row.dataset.id)}else{collapsed.set(row.dataset.id,footer.outerHTML);footer.outerHTML=expansion.footer}}}if(e.target.closest('[data-card],.gift-expand,a'))e.preventDefault()});select(0);
</script></html>`)
  }
  console.log(`Events (${locale}): six in-chat scenes, nested emotes/reply/reveal/deletion, cheer thresholds, avatars, themes, 300px geometry and reduced motion passed.`)
} catch (error) {
  const page = app.windows()[0]
  if (page && !page.isClosed()) {
    await page.screenshot({ path: resolve(artifacts, `events-${locale}-failure.png`) })
    console.error(await page.locator('#chat-log').innerText())
  }
  throw error
} finally { await app.close() }
