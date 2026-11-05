import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { PinDialogProvider } from './components/PinDialog'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PinDialogProvider>
      <App />
    </PinDialogProvider>
  </React.StrictMode>,
)
