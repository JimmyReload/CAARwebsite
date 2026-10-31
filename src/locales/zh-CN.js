/* ==========================================================
   CAAR · 简体中文文案（zh-CN）
   页面所有可见文字都在这里；组件里不再出现硬编码中文。
   新增语言：复制本文件为 en-US.js，在 ../i18n.js 的 locales 里注册即可。
   {xxx} 为插值占位符。

   文案依据：2025-02 至 2026-10 的群聊记录（总群 + 各队群）。
   赛期、名次、人名均取自聊天原文；行文取书面语，不用口语碎句。
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
    name: '中不正协',
    logoText: '中不正协',
    navCta: '申请入会',
  },
  nav: {
    about: '关于',
    projects: '战绩',
    members: '成员',
    faq: 'Q&A',
    login: '登录 / 注册',
    memberPanel: '成员面板',
    adminPanel: '管理后台',
    logout: '退出（{name}）',
  },

  /* ---------- 首页 hero ---------- */
  hero: {
    kicker: 'PUZZLE HUNT CLUB',
    title1: '中国不正常推理协会',
    title2: 'China Association of Abnormal Reasoning',
    subtitle: '一个以 puzzle hunt 为主要活动的解谜团体。组队、报名、限时解题、完赛，赛后互道一句「队友太强了」。',
    cta: '申请入会',
    meta: ['VOL.01', 'SINCE 2023', '8 HUNTS'],
    scroll: 'SCROLL',
  },

  /* ---------- 栏目编号 / 标题 / 英文角标 ---------- */
  sections: {
    about: { no: '01', title: '关于我们', en: 'ABOUT' },
    projects: { no: '02', title: '参赛记录', en: 'RECORDS' },
    members: { no: '03', title: '常驻成员', en: 'STAFF' },
    faq: { no: '04', title: '常见问题', en: 'Q&A' },
    contact: { no: '05', title: '加入我们', en: 'JOIN' },
  },

  /* ---------- 01 关于我们 ---------- */
  about: {
    image: '/images/caar-seal.png',
    name: 'CAAR',
    role: '解谜团体 · 2023 年至今',
    intro: [
      '中国不正常推理协会（China Association of Abnormal Reasoning，CAAR）是一个以 puzzle hunt 为主要活动的解谜团体，群内简称「中不正协」。',
      '协会成立于 2023 年。2025 年起以固定队伍参赛，当时的队名为「无我猪头好」；现行名称于 2026 年 6 月确定，由三括号、Tom 与 177 共同发起。',
      '截至 2026 年 10 月，共参赛八场、完赛七场，最好成绩为第 10 名。2026 年 9 月自办第一届「随蓝赛」，题目与站点均由成员完成。',
      '协会按赛事组建队伍：一队冲击名次，其余队伍以体验为主，老手可自愿带新手；赛事期间实行排班，成员按可上线时段轮值。协会不设准入门槛。',
    ],
    stats: [
      { value: '8', label: '参赛场次' },
      { value: '7', label: '完赛' },
      { value: '#10', label: '最好名次' },
      { value: '14', label: '群成员' },
    ],
  },

  /* ---------- 02 参赛记录（按时间倒序） ---------- */
  projects: [
    {
      title: '没有标题 · rk10',
      desc: '共 20 题的短程赛事，2 小时 27 分完赛，为协会目前最好名次。赛事方有两题出错，解题过程一度受阻。',
      tag: 'puzzle.cat',
      year: '2026/10/30',
      image: '',
    },
    {
      title: '迟来的中秋 · rk34',
      desc: '中秋主题的延期赛事，提示以「月饼」兑换。队内成员兑换了全部 12 条提示，进度一度领先。',
      tag: 'puzzle.cat',
      year: '2026/10/23 — 10/24',
      image: '',
    },
    {
      title: 'CCBC17 · rk64',
      desc: '一队冲击名次，另有两支队伍按观光配置参赛。长尾题目多由 GPT 协助完成；赛后共识是，若无其协助，完赛时间将增加约 24 小时。',
      tag: 'CCBC',
      year: '2026/8/14 — 8/23',
      image: '',
    },
    {
      title: 'P&KU3（中） · rk104',
      desc: '北京大学学生解谜协会主办的系列赛事，题量约为上半场的两倍。协会以 206 小时完赛，期间有成员参加考试、有成员乘机回国。',
      tag: 'P&KU',
      year: '2026/7/17 — 8/2',
      image: '',
    },
    {
      title: 'CCBC16 · rk166',
      desc: '协会首次整队参加 CCBC，历时 177 小时完赛，完成 52 题、6 个 meta。「52-6」的具体所指现已无人记得。',
      tag: 'CCBC',
      year: '2025/8/11 — 8/16',
      image: '',
    },
    {
      title: 'FDU PH25 · 未完赛',
      desc: '仅推进至一区 meta 即中止，参与成员两三人。严格而言不构成完整参赛，但确有参与。',
      tag: 'FDU',
      year: '2025/4',
      image: '',
    },
    {
      title: 'REXEI hunt · rk34',
      desc: '参赛时队伍仍名「无我猪头好」。第 34 名，为协会历史第二好成绩。',
      tag: 'REXEI',
      year: '2025/4',
      image: '',
    },
    {
      title: '蛇蛇 hunt · rk40',
      desc: '题量偏大的一场赛事，Meta 直接发布于群内；主办方亦提示「适度爬走益脑」。',
      tag: '蛇蛇',
      year: '2025/2',
      image: '',
    },
  ],

  /* ---------- 03 常驻成员 ---------- */
  members: [
    {
      name: 'Tom',
      role: '创始人 / 统筹与外交',
      avatar: '/images/avatars/tom.webp',
      desc: '自称 meta 苦手，实际负责统筹人员与赛事表格。赛期主要工作是催促进度、梳理群内信息。',
    },
    {
      name: '177',
      role: '创始人 / 运营与建站',
      avatar: '/images/avatars/cn177.webp',
      desc: '负责招募、文案与本站维护。在校学生，赛期可能因考试缺席。',
    },
    {
      name: 'ytyn',
      role: '纸笔手 / 出题',
      avatar: '/images/avatars/ytyn.webp',
      desc: '纸笔题与日谜主力，自评英语较弱。第一届随蓝赛的题目与站点均由其独立完成。',
    },
    {
      name: '三括号',
      role: '创始人 / 出题',
      avatar: '/images/avatars/sankuohao.webp',
      desc: '最早组织队伍者。后因参与度不足被「开除」，现为出题主力。',
    },
    {
      name: '甍',
      role: '中文题 / 通灵',
      avatar: '/images/avatars/meng.webp',
      desc: 'CCBC17 主力。中文题表现突出，其余题型自评「路边一条」。',
    },
    {
      name: 'Jack',
      role: '开盒手',
      avatar: '/images/avatars/jack.webp',
      desc: '负责信息检索与开盒。队内所用的检索方法多由其整理。',
    },
    {
      name: '缪月',
      role: '气氛 / 收尾',
      avatar: '/images/avatars/miaoyue.webp',
      desc: '提示兑换到底，兼司气氛，必要时负责收尾题目。',
    },
    {
      name: '小吉',
      role: '自由人 / 常客',
      avatar: '/images/avatars/xiaoji.webp',
      desc: '常以自由人身份参赛，主张每场更换队伍。蛇蛇 hunt 即与其同队。',
    },
  ],

  /* ---------- 04 常见问题 ---------- */
  faqs: [
    {
      q: '什么是 puzzle hunt？',
      a: '将数十道题目串联为一场限时赛事、并以 meta 收束的解谜活动，源自 MIT 的 Mystery Hunt 传统。国内有 CCBC、P&KU、justhunt 等赛事，通常一年一届，赛期一周至十天。',
    },
    {
      q: 'CAAR 是什么的缩写？',
      a: 'China Association of Abnormal Reasoning，即「中国不正常推理协会」的直译，群内简称「中不正协」。该译名由 Tom 确定；此前 AI 曾给出 China Didn\'t Normal Inference Association，因表述不通已废止。',
    },
    {
      q: '加入需要什么水平？',
      a: '无硬性门槛。队内既有纸笔手、开盒手与 meta 苦手，也有仅作观光的成员。一队冲击名次，二三队以体验为主，老手可自愿带新手。实际要求有两条：赛期能够上线，以及接受「完赛是底线」。',
    },
    {
      q: '需要熬夜吗？',
      a: '需要。赛事限时，队内会安排夜班，凌晨值守者次日补休。无法参与夜班亦可，只在自己可用的时段上线，队内称为观光。',
    },
    {
      q: '如何加入？',
      a: '填写入会问卷即可，入口见本页底部。问卷由问卷星提供，内容包括基本信息、入坑时间、擅长与不擅长的题型、赛期可上线时段、能否承担夜班；分组结果以私信通知。',
    },
    {
      q: '协会自行出题吗？',
      a: '会。2026 年 9 月举办第一届「随蓝赛」，形式为看描述猜词，题目与站点均由成员完成。另有成员在筹备个人赛事，进度长期停留在 6/28。',
    },
  ],

  /* ---------- 05 加入我们 ---------- */
  contact: {
    joinUrl: 'https://v.wjx.cn/vm/tEMfrKH.aspx#',
    joinLabel: '填写入会问卷',
    email: 'JimmyReload@qq.com',
    note: '入会问卷由问卷星提供，填写即表示已知悉并同意《入会信息收集声明》。\n其他事宜可通过邮件联系。',
    footer: '© 2023—2026 中不正协 · 解谜档案 2026',
    labels: { email: '邮箱' },
  },

  /* ---------- 登录 / 注册 ---------- */
  auth: {
    loginKicker: 'MEMBER LOGIN',
    registerKicker: 'SIGN UP',
    loginTitle: '成员登录',
    registerTitle: '注册账号',
    loginSub: '欢迎回来，继续解谜。',
    registerSub: '站内账号用于成员面板与站内信；正式入会请填写入会问卷（入口见首页底部）。',
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
    goRegister: '注册账号',
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
    inboxEmpty: '暂无站内信。报名、请假或提出建议，均可直接致信 STAFF。',
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
    noConversations: '暂无会员来信',
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
