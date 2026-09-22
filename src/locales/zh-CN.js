/* ==========================================================
   CAAR · 简体中文文案（zh-CN）
   页面所有可见文字都在这里；组件里不再出现硬编码中文。
   新增语言：复制本文件为 en-US.js，在 ../i18n.js 的 locales 里注册即可。
   {xxx} 为插值占位符。
   ========================================================== */

export default {
  /* ---------- 通用 ---------- */
  common: {
    backHome: '← 返回首页',
  },
  password: {
    old: '原密码',
    next: '新密码',
    placeholder: '至少 6 位',
    save: '保存新密码',
    ok: '✓ 密码已更新',
  },

  /* ---------- 站点 / 刊头 ---------- */
  site: {
    name: '中国不正常推理协会',
    logoText: '不正常推理协会',
    navCta: '联系我们',
  },
  nav: {
    about: '档案',
    projects: '项目',
    members: '成员',
    faq: 'Q&A',
    login: '登录 / 入会',
    memberPanel: '成员面板',
    adminPanel: '管理后台',
    logout: '退出（{name}）',
  },

  /* ---------- 首页 hero ---------- */
  hero: {
    kicker: 'China Abnormal Puzzling Association',
    title1: '中国不正常推理协会',
    title2: 'China Abnormal Puzzling Association',
    subtitle: 'Everything or Nothing.——我们用不正常的脑回路，解最正经的谜。',
    cta: '加入我们',
    meta: ['VOL.01', 'EST. 2023', 'CAAR'],
    scroll: 'SCROLL',
  },

  /* ---------- 栏目编号 / 标题 / 英文角标 ---------- */
  sections: {
    about: { no: '01', title: '编者按', en: 'ABOUT' },
    projects: { no: '02', title: '本期报道', en: 'RECORDS' },
    members: { no: '03', title: '作者名录', en: 'STAFF' },
    faq: { no: '04', title: '读者来信', en: 'Q&A' },
    contact: { no: '05', title: '联系我们', en: 'CONTACT' },
  },

  /* ---------- 01 编者按 ---------- */
  about: {
    image: '/images/caar-hero.jpg',
    name: 'cn177',
    role: '会长 / 运营',
    intro: [
      '我是177，中国不正常推理协会的会长。',
      '本协会成立于 2023 年，以 puzzle hunt 为业：读谜、拆谜、组队、完赛，偶尔出题祸害同行。',
      '成立至今已参加多项国内重要赛事，战绩尚可，乐在其中。',
    ],
    contact: {
      email: '743899771@qq.com',
      phone: '+86 18519670015',
      location: '中国 · 内蒙古',
      qq: 'QQ 743899771',
    },
    labels: { email: '邮箱', phone: '电话', location: '所在', qq: 'QQ' },
    stats: [
      { value: 'EZ hunt', label: '筹备中项目' },
      { value: '7', label: '参赛次数' },
      { value: '7', label: '完赛数' },
      { value: '14', label: '成员数' },
    ],
  },

  /* ---------- 02 本期报道 ---------- */
  projects: [
    {
      title: 'CCBC 17',
      desc: '第十七届 CCBC：国内规模最大的解谜比赛之一，组队啃完全程。',
      tag: 'CCBC',
      year: '2026/8/14 — 8/23',
      image: '',
    },
    {
      title: 'P&KU3 进行中',
      desc: '北京大学学生解谜协会推出的 Puzzle Hunt 系列赛事，正在攻坚。',
      tag: 'P&KU',
      year: '2026/7/17 — 8/2',
      image: '',
    },
  ],

  /* ---------- 03 作者名录 ---------- */
  members: [
    { name: '177', role: '会长', avatar: '/images/caar-hero.jpg', desc: '协会创始人，负责把大家拉进不解完不罢休的坑。' },
    { name: 'Tom', role: '副会长', avatar: 'https://q1.qlogo.cn/g?b=qq&nk=3152841984&s=640', desc: '协会的第二个大脑，擅长统筹与后勤。' },
    { name: 'ytyn', role: '纸笔手', avatar: 'https://q1.qlogo.cn/g?b=qq&nk=3991453315&s=640', desc: '纸笔题担当，笔尖即武器。' },
    { name: '虚位以待', role: '等你加入', avatar: '', desc: '下一块拼图，可能是你。' },
  ],

  /* ---------- 04 读者来信 ---------- */
  faqs: [
    { q: '这个协会是干什么的？', a: '我们玩一种叫 puzzle hunt 的解谜游戏——它最早起源于 MIT，后经 CCBC 等赛事在国内流行，诞生了 justhunt、P&KU、CCBC 等优秀作品。我们就是为了一起愉快地啃下这些谜题而成立的。' },
    { q: '加入你们有什么好处？', a: '协会不提供经济支持，但提供：方便的组队系统、靠谱的队友、比赛期的流程保障，以及每个会员都应得的游戏体验。' },
    { q: '怎么加入你们？', a: '填写入会问卷，让我们更好地了解你。问卷为问卷星提供网页，填写即代表你知晓并同意《协会协定》中的内容。' },
    { q: '平时都做些什么？', a: '围绕 CCBC、P&KU 等大赛组队参赛；平时在大群交流解谜技巧、组织训练，偶尔也自己出题互相折磨。' },
  ],

  /* ---------- 05 联系我们 ---------- */
  contact: {
    email: '743899771@qq.com',
    phone: '+86 18519670015',
    location: '中国 · 内蒙古',
    qq: 'QQ 743899771',
    note: '欢迎进入中不正协大群交流解谜和其他一切！\n（入会问卷为问卷星提供网页，填写即代表你知晓并同意《协会协定》中的内容）',
    footer: '© 中国不正常推理协会 2023-2026 · 解谜档案 No.CAAR-2026',
    labels: { phone: '电话', address: '地址', qq: 'QQ' },
  },

  /* ---------- 登录 / 注册 ---------- */
  auth: {
    loginKicker: 'MEMBER LOGIN',
    registerKicker: 'JOIN US',
    loginTitle: '成员登录',
    registerTitle: '申请入会',
    loginSub: '欢迎回来，继续解谜。',
    registerSub: '开放注册——读完《入会协定》即可申请。',
    nicknameLabel: '昵称（选填）',
    nicknamePlaceholder: '怎么称呼你',
    usernameLabel: '用户名',
    usernamePlaceholder: '2-20 位，中文/字母/数字/下划线',
    passwordLabel: '密码',
    passwordPlaceholder: '至少 6 位',
    busy: '处理中…',
    login: '登录',
    register: '注册',
    registerOk: '注册成功，请登录',
    noAccount: '还没有账号？',
    hasAccount: '已有账号？',
    goRegister: '申请入会',
    goLogin: '直接登录',
  },

  /* ---------- 成员面板 ---------- */
  member: {
    kicker: 'MEMBER DESK',
    title: '成员面板',
    announcements: '协会公告',
    noAnnouncements: '暂无公告',
    pinned: '置顶公告',
    inbox: '站内信',
    inboxEmpty: '还没有发过站内信——有问题、有想法，直接写给 STAFF（会在此回复你）',
    me: '我',
    staff: 'STAFF',
    messagePlaceholder: '输入消息…（≤1000 字）',
    send: '发送',
    changePassword: '修改密码',
  },

  /* ---------- 管理后台 ---------- */
  admin: {
    kicker: 'ADMIN CONSOLE',
    title: '管理后台',
    tabs: {
      dash: '概览',
      conv: '来信',
      convUnread: '来信 ({n})',
      ann: '公告',
      annEditing: '公告（编辑中）',
      users: '用户权限',
    },
    stats: {
      total: '会员总数',
      new7: '近 7 日新增',
      admins: 'STAFF',
      convs: '工单总数',
      unreadConvs: '未读工单',
      anns: '公告',
    },
    myPassword: '修改我的密码',
    noConversations: '还没有会员来信',
    unreadCount: '{n} 条未读',
    read: '已读',
    backToList: '← 返回工单列表',
    conversationWith: '与 {name}（@{username}）的对话',
    roleMemberSuffix: '（会员）',
    replyPlaceholder: '回复该会员…',
    reply: '回复',
    annForm: {
      titleLabel: '标题',
      contentLabel: '内容',
      pinnedLabel: '置顶',
      save: '保存修改',
      publish: '发布公告',
      cancelEdit: '取消编辑',
      edit: '编辑',
      delete: '删除',
    },
    users: {
      searchPlaceholder: '搜索用户名 / 昵称…',
      search: '搜索',
      clear: '清空',
      roleStaff: 'STAFF',
      roleMember: '会员',
      banned: '已封禁',
      demote: '降为会员',
      promote: '设为 STAFF',
      resetPassword: '重置密码',
      unban: '解封',
      ban: '封禁',
      promptNewPassword: '为 {name} 设置新密码（至少 6 位）：',
      resetDone: '已重置 {username} 的密码',
    },
  },

  /* ---------- 前端 API 封装 ---------- */
  api: {
    failed: '请求失败',
    timeout: '请求超时，请检查网络后重试',
  },

  /* ---------- 服务端（worker）返回的文案 ---------- */
  errors: {
    usernameLength: '用户名需 2-20 个字符',
    usernameCharset: '用户名只能含中文/字母/数字/下划线',
    passwordLength: '密码至少 6 位',
    usernameTaken: '该用户名已被注册',
    badCredentials: '用户名或密码错误',
    banned: '该账号已被封禁，请联系 STAFF',
    wrongOldPassword: '原密码错误',
    newPasswordLength: '新密码至少 6 位',
    unauthorized: '未登录',
    adminOnly: '需要管理员权限',
    announceEmpty: '标题和内容不能为空',
    contentEmpty: '内容不能为空',
    contentTooLong: '内容过长（≤1000 字）',
    badParams: '参数不完整',
    convNotFound: '会话不存在',
    forbidden: '无权访问',
    invalidRole: '非法角色',
    cannotDemoteSelf: '不能撤销自己的管理员',
    cannotBanSelf: '不能封禁自己',
    titleEmpty: '标题不能为空',
  },
}
