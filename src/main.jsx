import React from 'react'

import ReactDOM from 'react-dom/client'

import App from './App.jsx'

import './index.css'

// 全局异常上报：先注册再渲染，首屏报错也能被收集
import './reportError'



ReactDOM.createRoot(document.getElementById('root')).render(

  <React.StrictMode>

    <App />

  </React.StrictMode>

)
