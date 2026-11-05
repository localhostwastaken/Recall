import { createRoot } from 'react-dom/client';
import '../../recall/ui/tokens.css';
import '../../recall/ui/base.css';
import './popup.css';
import { Popup } from './Popup';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<Popup />);
}
