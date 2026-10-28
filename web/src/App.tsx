import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowUpRight, BookOpen, Brain, CalendarClock, ChevronDown, ChevronLeft, ChevronRight, Cpu, GraduationCap, LogOut, Menu, MessageSquare, Moon, Plus, Plug, Send, Settings, ShieldCheck, Sun, UserRound, Users, Workflow } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, ApiError, items, post } from './api';
import type { Setup, User, Workspace } from './api';
import Auth, { ResetPassword } from './Auth';
import Chat from './Chat';
import Resources from './Resources';
import DeveloperTutorials from './DeveloperTutorials';
import Account from './Security';
import AuthenticationSettings from './AuthSettings';
import { Members, Runs, Settings as SettingsPage } from './Operations';
import { safePreference, savePreference } from './data';
import { Brand, Button, Empty, ErrorNotice, Field, LanguageContext, Loading, Modal, useText } from './ui';
import type { Language } from './ui';
import { roleAllows } from './permissions';
import { listenForSessionChange, notifySessionChange } from './sessionChange';

type Page = 'chat' | 'runs' | 'knowledge' | 'memories' | 'schedules' | 'agents' | 'routes' | 'models' | 'plugins' | 'members' | 'settings' | 'account' | 'auth-settings' | 'developer';
type NavItem = { page: Page; title: [string, string]; icon: LucideIcon; group: number };
const navigation: NavItem[] = [
  { page: 'chat', title: ['对话', 'Conversations'], icon: MessageSquare, group: 0 },
  { page: 'runs', title: ['运行与收件箱', 'Runs & inbox'], icon: Activity, group: 0 },
  { page: 'schedules', title: ['计划任务', 'Schedules'], icon: CalendarClock, group: 0 },
  { page: 'knowledge', title: ['知识库', 'Knowledge'], icon: BookOpen, group: 1 },
  { page: 'memories', title: ['记忆', 'Memory'], icon: Brain, group: 1 },
  { page: 'agents', title: ['代理', 'Agents'], icon: Workflow, group: 1 },
  { page: 'models', title: ['模型', 'Models'], icon: Cpu, group: 2 },
  { page: 'routes', title: ['机器人与渠道', 'Channels'], icon: Send, group: 2 },
  { page: 'plugins', title: ['插件', 'Plugins'], icon: Plug, group: 2 },
  { page: 'members', title: ['成员', 'Members'], icon: Users, group: 3 },
  { page: 'settings', title: ['工作区设置', 'Settings & audit'], icon: Settings, group: 3 },
  { page: 'account', title: ['账号与安全', 'Account & security'], icon: UserRound, group: 4 },
  { page: 'auth-settings', title: ['认证与邮件', 'Authentication & email'], icon: ShieldCheck, group: 4 },
  { page: 'developer', title: ['开发者教程', 'Developer tutorials'], icon: GraduationCap, group: 5 },
];
const groups: [string, string, LucideIcon][] = [
  ['工作', 'Work', MessageSquare],
  ['知识与代理', 'Knowledge', BookOpen],
  ['连接', 'Connections', Plug],
  ['工作区管理', 'Workspace', Settings],
  ['账号', 'Account', UserRound],
  ['开发者', 'Developer', GraduationCap],
];

export default function App() {
  const [language, setLanguage] = useState<Language>(() => safePreference('language', navigator.language.startsWith('zh') ? 'zh' : 'en') === 'zh' ? 'zh' : 'en');
  const [theme, setTheme] = useState(() => safePreference('theme', 'dark') === 'light' ? 'light' : 'dark');
  const t = (zh: string, en: string) => language === 'zh' ? zh : en;
  useEffect(() => { document.documentElement.dataset.theme = theme; savePreference('theme', theme); }, [theme]);
  useEffect(() => { document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; savePreference('language', language); }, [language]);
  return <LanguageContext value={language}><div className="preferences"><Button variant="ghost icon" aria-label={theme === 'dark' ? t('切换到浅色主题', 'Switch to light theme') : t('切换到深色主题', 'Switch to dark theme')} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</Button><Button variant="ghost language" onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')} aria-label={t('切换语言', 'Change language')}>{language === 'zh' ? 'EN' : '中'}</Button></div><Entry /></LanguageContext>;
}

function Entry() {
  const { t } = useText(); const client = useQueryClient(); const identity = useRef<string | null>(null); const changedIdentity = useRef(false); const resetIdentity = useRef(false); const [sessionExpired, setSessionExpired] = useState(false); const [fragment, setFragment] = useState(location.hash.slice(1));
  useEffect(() => {
    const expire = () => setSessionExpired(true); const changeHash = () => setFragment(location.hash.slice(1));
    window.addEventListener('rstrbot:session-expired', expire); window.addEventListener('hashchange', changeHash);
    return () => { window.removeEventListener('rstrbot:session-expired', expire); window.removeEventListener('hashchange', changeHash); };
  }, []);
  const setup = useQuery({ queryKey: ['setup'], queryFn: ({ signal }) => api<Setup>('/setup', { signal }) });
  const [otherSessionChanged, setOtherSessionChanged] = useState(false);
  useEffect(() => listenForSessionChange(() => setOtherSessionChanged(true)), []);
  useEffect(() => {
    // OAuth returns by navigation rather than the password/passkey fetch path.
    const url = new URL(location.href);
    if (url.searchParams.get('auth') === 'success') {
      url.searchParams.delete('auth');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      notifySessionChange();
    }
  }, []);
  const me = useQuery({ queryKey: ['me'], enabled: setup.data?.initialized === true, queryFn: ({ signal }) => api<{ user: User }>('/auth/me', { signal }) });
  const incomingIdentity = me.data?.user.id;
  // Another tab may replace the shared HttpOnly session cookie. Block the
  // incoming identity before any workspace-only cache can render under it.
  if (otherSessionChanged || (identity.current && incomingIdentity && identity.current !== incomingIdentity)) changedIdentity.current = true;
  useLayoutEffect(() => {
    if (changedIdentity.current) {
      if (!resetIdentity.current) {
        resetIdentity.current = true;
        void client.cancelQueries().catch(() => undefined).then(() => { client.clear(); window.location.reload(); });
      }
    } else if (incomingIdentity) identity.current = incomingIdentity;
  }, [incomingIdentity, otherSessionChanged, client]);
  const parameters = new URLSearchParams(fragment); const reset = parameters.get('reset-password'); const verify = parameters.get('verify-email');
  function clearVerification() { history.replaceState(null, '', `${location.pathname}${location.search}#account`); setFragment('account'); }
  if (changedIdentity.current) return <main className="boot"><Brand /><Loading text={t('账号已切换，正在重新载入…', 'Your account changed. Reloading…')} /></main>;
  if (reset) return <ResetPassword key={reset} token={reset} />;
  if (setup.isPending || (setup.data?.initialized && me.isPending)) return <main className="boot"><Brand /><Loading text={t('正在连接你的工作区…', 'Connecting to your workspace…')} /></main>;
  if (setup.error) return <main className="boot"><Brand /><ErrorNotice error={setup.error} onRetry={() => setup.refetch()} /></main>;
  // A cached identity must not survive a server authentication failure.
  if (!setup.data?.initialized || !me.data?.user || sessionExpired || (me.error instanceof ApiError && me.error.status === 401)) return <Auth setup={setup.data!} verifyingEmail={!!verify} />;
  return <Shell key={me.data.user.id} user={me.data.user} verifyToken={verify ?? undefined} clearVerifyToken={clearVerification} />;
}

function initialPage(): Page {
  const hash = location.hash.slice(1);
  if (hash.startsWith('verify-email=') || hash === 'account') return 'account';
  if (hash === 'auth-settings') return 'auth-settings';
  try { const returned = sessionStorage.getItem('rstrbot:auth-return'); if (returned === 'account' || returned === 'auth-settings') return returned; } catch { /* Session storage is optional. */ }
  return 'chat';
}

function Shell({ user, verifyToken, clearVerifyToken }: { user: User; verifyToken?: string; clearVerifyToken: () => void }) {
  const { t } = useText(); const client = useQueryClient();
  const workspaces = useQuery({ queryKey: ['workspaces', user.id], queryFn: ({ signal }) => api<{ items: Workspace[] }>('/workspaces', { signal }).then(items), refetchInterval: 10000 });
  const [wid, setWid] = useState(() => safePreference(`workspace:${user.id}`)); const [page, setPage] = useState<Page>(initialPage);
  const [navigationLayout, setNavigationLayout] = useState<'sidebar' | 'top'>(() => safePreference(`navigation-layout:${user.id}`, 'sidebar') === 'top' ? 'top' : 'sidebar');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => safePreference(`navigation-collapsed:${user.id}`) === 'true');
  const [openNavigationGroup, setOpenNavigationGroup] = useState<number | null>(null);
  const [drawer, setDrawer] = useState(false); const [newWorkspace, setNewWorkspace] = useState(false); const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(() => new URLSearchParams(location.search).get('auth') === 'failed' ? new Error(t('Google 操作未完成，请重新尝试。', 'The Google sign-in or linking operation did not complete. Please try again.')) : null); const [busy, setBusy] = useState(false); const lastMembership = useRef<{ id: string; role: string } | null>(null);
  const workspace = workspaces.data?.find(item => item.id === wid) ?? workspaces.data?.[0];
  useEffect(() => { savePreference(`navigation-layout:${user.id}`, navigationLayout); }, [navigationLayout, user.id]);
  useEffect(() => { savePreference(`navigation-collapsed:${user.id}`, String(sidebarCollapsed)); }, [sidebarCollapsed, user.id]);
  const capabilities = useQuery({ queryKey: [workspace?.id, 'capabilities'], enabled: !!workspace, refetchInterval: 5000, queryFn: ({ signal }) => api<Record<string, { supported: boolean; authorized: boolean; available: boolean }>>(`/workspaces/${workspace!.id}/capabilities`, { signal }) });
  const visibleNavigation = navigation.filter(item => {
    if (item.page === 'account') return true;
    if (item.page === 'auth-settings') return user.instance_admin === true;
    if (item.page === 'developer') return true;
    if (!workspace) return false;
    if (['members', 'plugins', 'routes'].includes(item.page)) {
      const capability = capabilities.data?.[item.page]; const minimum = item.page === 'routes' ? 'member' : 'admin';
      return roleAllows(workspace.role, minimum) && (!capability || capability.supported && capability.authorized);
    }
    return true;
  });
  useLayoutEffect(() => {
    const previous = lastMembership.current;
    if (workspace && previous?.id === workspace.id && previous.role !== workspace.role) void client.resetQueries({ queryKey: [workspace.id] });
    lastMembership.current = workspace ? { id: workspace.id, role: workspace.role } : null;
  }, [workspace?.id, workspace?.role, client]);
  const currentPage = page === 'chat' || visibleNavigation.some(item => item.page === page) ? page : 'chat';
  const accountPage = currentPage === 'account' || currentPage === 'auth-settings';
  useLayoutEffect(() => { document.getElementById('main-content')?.scrollTo({ top: 0 }); }, [currentPage, workspace?.id, verifyToken]);
  useEffect(() => { try { sessionStorage.removeItem('rstrbot:auth-return'); } catch { /* Optional return hint. */ } const url = new URL(location.href); if (url.searchParams.has('auth')) { url.searchParams.delete('auth'); history.replaceState(null, '', url.pathname + url.search + url.hash); } }, []);
  useEffect(() => { if (verifyToken) setPage('account'); }, [verifyToken]);
  useEffect(() => { if (currentPage !== page) setPage(currentPage); }, [currentPage, page]);
  useEffect(() => { if (workspace && workspace.id !== wid) setWid(workspace.id); }, [workspace, wid]);
  useEffect(() => {
    if (openNavigationGroup === null) return;
    const closeOutside = (event: PointerEvent) => { if (event.target instanceof Element && !event.target.closest('.top-navigation-shell')) setOpenNavigationGroup(null); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenNavigationGroup(null); };
    document.addEventListener('pointerdown', closeOutside); document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, [openNavigationGroup]);
  function go(id: Page) { setPage(id); setDrawer(false); setOpenNavigationGroup(null); setError(null); if (!verifyToken) history.replaceState(null, '', `${location.pathname}${location.search}${['account', 'auth-settings'].includes(id) ? `#${id}` : ''}`); }
  async function switchWorkspace(id: string) { await client.cancelQueries({ queryKey: [wid] }); setWid(id); savePreference(`workspace:${user.id}`, id); setDrawer(false); setError(null); }
  async function logout() { setError(null); try { await post('/auth/logout'); await client.cancelQueries(); client.clear(); window.location.assign('/'); } catch (err) { setError(err); } }
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try { const response = await post<Workspace | { workspace: Workspace }>('/workspaces', { name }); const created = 'workspace' in response ? response.workspace : response; setWid(created.id); savePreference(`workspace:${user.id}`, created.id); await client.invalidateQueries({ queryKey: ['workspaces'] }); setNewWorkspace(false); setName(''); go('chat'); }
    catch (err) { setError(err); } finally { setBusy(false); }
  }
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const autoCollapseTarget = navigationLayout === 'sidebar' && viewportWidth >= 720 && viewportWidth <= 1100
    ? 'sidebar'
    : viewportWidth < 720 || (navigationLayout === 'top' && viewportWidth <= 1199) ? 'header' : null;
  const effectivelyCollapsed = sidebarCollapsed || (autoCollapseTarget === 'sidebar' && autoCollapsed);
  const autoHeaderHidden = autoCollapseTarget === 'header' && autoCollapsed;
  const navigationScrollState = useRef(new WeakMap<HTMLElement, { top: number; pending: number; down: number; up: number; intentUntil: number }>());
  const touchIntent = useRef<{ y: number; element: HTMLElement } | null>(null);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    setAutoCollapsed(false);
    if (!autoCollapseTarget) return;
    const main = document.getElementById('main-content');
    if (!main) return;
    const scrollables = [main, ...Array.from(main.querySelectorAll<HTMLElement>('.messages'))];
    const state = navigationScrollState.current;
    for (const element of scrollables) state.set(element, { top: element.scrollTop, pending: 0, down: 0, up: 0, intentUntil: 0 });
    const blocked = (target: EventTarget | null) => {
      if (document.querySelector('.dialog[open]')) return true;
      if (openNavigationGroup !== null) return true;
      if (document.activeElement instanceof HTMLElement && document.activeElement.matches('input, textarea, select, [contenteditable="true"]')) return true;
      return target instanceof Element && !!target.closest('.dialog, input, textarea, select, [contenteditable="true"], .main-sidebar');
    };
    const intent = (element: HTMLElement, delta: number) => {
      const current = state.get(element);
      if (current && Math.abs(delta) >= 1) current.intentUntil = performance.now() + 550;
    };
    const onWheel = (event: WheelEvent) => {
      if (blocked(event.target)) return;
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>('.messages') ?? main : main;
      intent(element, event.deltaY);
    };
    const onTouchStart = (event: TouchEvent) => {
      if (blocked(event.target) || event.touches.length !== 1) { touchIntent.current = null; return; }
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>('.messages') ?? main : main;
      touchIntent.current = { y: event.touches[0].clientY, element };
    };
    const onTouchMove = (event: TouchEvent) => {
      const active = touchIntent.current;
      if (!active || event.touches.length !== 1) return;
      const delta = active.y - event.touches[0].clientY;
      if (Math.abs(delta) >= 4) { intent(active.element, delta); active.y = event.touches[0].clientY; }
    };
    const onTouchEnd = () => { touchIntent.current = null; };
    const onKeyDown = (event: KeyboardEvent) => {
      if (blocked(event.target)) return;
      const delta = event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ' || event.key === 'End' ? 1 : event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home' ? -1 : 0;
      if (!delta) return;
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>('.messages') ?? main : main;
      intent(element, delta);
    };
    const onScroll = (event: Event) => {
      const element = event.currentTarget as HTMLElement;
      const current = state.get(element);
      if (!current) return;
      const top = element.scrollTop;
      let delta = top - current.top;
      current.top = top;
      if (Math.abs(delta) < 4) { current.pending += delta; return; }
      delta += current.pending;
      current.pending = 0;
      if (performance.now() > current.intentUntil || blocked(event.target)) return;
      if (top <= 96) { current.down = 0; current.up = 0; setAutoCollapsed(false); return; }
      if (delta > 0) { current.down += delta; current.up = 0; if (current.down >= 48) { current.down = 0; setAutoCollapsed(true); } }
      else { current.up += -delta; current.down = 0; if (current.up >= 24) { current.up = 0; setAutoCollapsed(false); } }
    };
    main.addEventListener('wheel', onWheel, { passive: true });
    main.addEventListener('touchstart', onTouchStart, { passive: true });
    main.addEventListener('touchmove', onTouchMove, { passive: true });
    main.addEventListener('touchend', onTouchEnd, { passive: true });
    main.addEventListener('touchcancel', onTouchEnd, { passive: true });
    main.addEventListener('keydown', onKeyDown);
    for (const element of scrollables) element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      main.removeEventListener('wheel', onWheel);
      main.removeEventListener('touchstart', onTouchStart);
      main.removeEventListener('touchmove', onTouchMove);
      main.removeEventListener('touchend', onTouchEnd);
      main.removeEventListener('touchcancel', onTouchEnd);
      main.removeEventListener('keydown', onKeyDown);
      for (const element of scrollables) element.removeEventListener('scroll', onScroll);
      touchIntent.current = null;
    };
  }, [autoCollapseTarget, currentPage, navigationLayout, openNavigationGroup, viewportWidth, workspace?.id]);
  const workspaceChooser = <div className="workspace-chooser"><label><span className="eyebrow">{t('工作区', 'WORKSPACE')}</span><select aria-label={t('切换工作区', 'Switch workspace')} value={workspace?.id ?? ''} onChange={event => void switchWorkspace(event.target.value)}>{!workspace && <option value="">{t('尚无工作区', 'No workspace')}</option>}{workspaces.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><Button variant="ghost icon" aria-label={t('建立工作区', 'Create workspace')} onClick={() => setNewWorkspace(true)}><Plus size={17} /></Button></div>;
  const renderNavigationLinks = () => <nav aria-label={t('主导航', 'Main navigation')}>{groups.map(([labelZh, labelEn], group) => visibleNavigation.some(item => item.group === group) && <div className="navigation-group" key={group} aria-label={t(labelZh, labelEn)}><p className="nav-section-label">{t(labelZh, labelEn)}</p><div className="nav-group">{visibleNavigation.filter(item => item.group === group).map(({ page: id, title, icon: Icon }) => <button key={id} className={`nav-item ${currentPage === id ? 'active' : ''}`} aria-label={t(...title)} aria-current={currentPage === id ? 'page' : undefined} onClick={() => go(id)}><Icon size={17} /><span>{t(...title)}</span>{currentPage === id && <span className="nav-active-dot" />}</button>)}</div></div>)}</nav>;
  const renderTopNavigationLinks = () => <nav className="top-navigation-links" aria-label={t('主导航', 'Main navigation')} onKeyDown={event => { if (event.key === 'Escape') setOpenNavigationGroup(null); }}>{groups.map(([labelZh, labelEn, Icon], group) => {
    const pages = visibleNavigation.filter(item => item.group === group);
    if (!pages.length) return null;
    const activePage = pages.find(item => item.page === currentPage);
    const menuId = `top-navigation-menu-${group}`;
    return <div className={`top-navigation-group ${activePage ? 'active' : ''}`} key={group}>
      <button type="button" className="top-navigation-trigger" aria-label={activePage ? `${t(labelZh, labelEn)}: ${t(...activePage.title)}` : t(labelZh, labelEn)} aria-haspopup="true" aria-expanded={openNavigationGroup === group} aria-controls={menuId} onClick={() => setOpenNavigationGroup(openNavigationGroup === group ? null : group)}><Icon size={16} aria-hidden="true" /><span>{t(labelZh, labelEn)}</span>{activePage && <span className="top-navigation-active-mark" aria-hidden="true" />}<ChevronDown size={14} aria-hidden="true" /></button>
      {openNavigationGroup === group && <div className="top-navigation-menu" id={menuId} role="group" aria-label={t(labelZh, labelEn)}>{pages.map(({ page: id, title, icon: PageIcon }) => <button type="button" key={id} className={`top-navigation-option ${currentPage === id ? 'active' : ''}`} aria-current={currentPage === id ? 'page' : undefined} onClick={() => go(id)}><PageIcon size={17} /><span>{t(...title)}</span></button>)}</div>}
    </div>;
  })}</nav>;
  const accountControls = <div className="account"><button className="account-button" onClick={() => go('account')} aria-label={t('打开账号与安全', 'Open account & security')}><span className="avatar">{user.username.slice(0, 2).toUpperCase()}</span><span><strong>{user.username}</strong><small>{user.instance_admin ? t('实例管理员', 'Administrator') : t('个人账号', 'Personal account')}</small></span></button><Button variant="ghost icon" aria-label={t('退出登录', 'Sign out')} onClick={logout}><LogOut size={17} /></Button></div>;
  const nav = <>{workspaceChooser}{renderNavigationLinks()}<div className="sidebar-bottom">{accountControls}</div></>;
  const layoutControl = <div className="nav-layout-control" role="group" aria-label={t('导航布局', 'Navigation layout')}><Button variant="ghost" className={navigationLayout === 'sidebar' ? 'selected' : ''} aria-pressed={navigationLayout === 'sidebar'} onClick={() => setNavigationLayout('sidebar')}>{t('侧栏', 'Sidebar')}</Button><Button variant="ghost" className={navigationLayout === 'top' ? 'selected' : ''} aria-pressed={navigationLayout === 'top'} onClick={() => setNavigationLayout('top')}>{t('顶栏', 'Top bar')}</Button></div>;
  const topNavigation = <div className="top-navigation-shell"><div className="top-navigation-workspace">{workspaceChooser}</div>{renderTopNavigationLinks()}<div className="top-navigation-account">{accountControls}</div></div>;
  const activeTitle = navigation.find(item => item.page === currentPage)!.title;
  return <div className={`app-shell ${navigationLayout === 'top' ? 'layout-top' : ''} ${effectivelyCollapsed ? 'sidebar-collapsed' : ''} ${autoHeaderHidden ? 'auto-header-hidden' : ''}`}>
    <a className="skip-link" href="#main-content">{t('跳到主要内容', 'Skip to main content')}</a>
    {navigationLayout === 'sidebar' && <aside className={`main-sidebar ${effectivelyCollapsed ? 'is-collapsed' : ''}`}>
      <div className="brand-row"><a className="brand-link" href="#" onClick={event => { event.preventDefault(); go('chat'); }} aria-label="RstrBot"><Brand /></a><Button variant="ghost icon sidebar-collapse-control" aria-label={effectivelyCollapsed ? t('展开侧栏', 'Expand sidebar') : t('折叠侧栏', 'Collapse sidebar')} title={effectivelyCollapsed ? t('展开侧栏', 'Expand sidebar') : t('折叠侧栏', 'Collapse sidebar')} onClick={() => { setSidebarCollapsed(!effectivelyCollapsed); setAutoCollapsed(false); }}><ChevronLeft size={17} /></Button></div>
      <div className="sidebar-navigation">{nav}</div>
    </aside>}
    <div className="workspace-shell">
      <header className="topbar">
        <div className="row">{navigationLayout === 'top' ? <Button variant="ghost icon compact-navigation-trigger" aria-label={t('打开导航', 'Open navigation')} aria-expanded={drawer} onClick={() => setDrawer(true)}><Menu size={20} /></Button> : <Button variant="ghost icon mobile-only" aria-label={t('打开导航', 'Open navigation')} aria-expanded={drawer} onClick={() => setDrawer(true)}><Menu size={20} /></Button>}{navigationLayout === 'top' ? <a className="topbar-brand" href="#" onClick={event => { event.preventDefault(); go('chat'); }} aria-label="RstrBot"><Brand /></a> : <span className="topbar-workspace">{accountPage ? user.username : workspace?.name ?? 'RstrBot'}</span>}<ChevronRight className="topbar-separator" size={14} /><span className="topbar-current">{t(...activeTitle)}</span><div className="topbar-layout-control">{layoutControl}</div></div>
        {navigationLayout === 'top' && topNavigation}
      </header>
      <main id="main-content" className={`main-content ${currentPage === 'chat' && workspace ? 'chat-content' : ''}`} tabIndex={-1}>
        <ErrorNotice error={error || (!accountPage ? workspaces.error : null)} onRetry={() => workspaces.refetch()} />
        {currentPage === 'account' ? <Account key={user.id} user={user} goAdmin={user.instance_admin ? () => go('auth-settings') : undefined} verifyToken={verifyToken} clearVerifyToken={clearVerifyToken} /> : currentPage === 'auth-settings' ? <AuthenticationSettings user={user} back={() => go('account')} /> : currentPage === 'developer' ? <DeveloperTutorials user={user} /> : workspaces.isPending ? <Loading /> : !workspace ? <Empty title={t('建立第一个工作区', 'Create your first workspace')} description={t('将对话、模型和资料放在同一处，也可以请管理员邀请你加入团队。', 'Keep your conversations, models and knowledge together, or ask an administrator to invite you into a team.')} action={<Button variant="primary" onClick={() => setNewWorkspace(true)}><Plus size={17} />{t('建立工作区', 'Create workspace')}</Button>} /> : <div className="page-mount" key={`${user.id}:${workspace.id}:${workspace.role}:${currentPage}`}>{currentPage === 'chat' ? <Chat workspace={workspace} user={user} goModels={() => go('models')} /> : currentPage === 'runs' ? <Runs workspace={workspace} user={user} /> : currentPage === 'members' ? <Members workspace={workspace} user={user} /> : currentPage === 'settings' ? <SettingsPage workspace={workspace} user={user} /> : <Resources kind={currentPage} workspace={workspace} user={user} />}</div>}
      </main>
    </div>
    {drawer && <Modal title="RstrBot" close={() => setDrawer(false)}><div className="mobile-nav"><div className="mobile-layout-control">{layoutControl}</div>{nav}</div></Modal>}
    {newWorkspace && <Modal title={t('建立工作区', 'Create workspace')} close={() => setNewWorkspace(false)}><form className="stack" onSubmit={create}><ErrorNotice error={error} /><Field label={t('名称', 'Name')}><input required value={name} onChange={event => setName(event.target.value)} autoFocus maxLength={120} placeholder={t('例如：个人研究', 'For example: personal research')} /></Field><Button type="submit" variant="primary" busy={busy}>{t('建立', 'Create')}<ArrowUpRight size={17} /></Button></form></Modal>}
  </div>;
}
