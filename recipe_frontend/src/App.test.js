import { render, screen } from '@testing-library/react';
import App from './App';

test('renders app title', () => {
  render(<App />);
  const heading = screen.getByText(/Recipe Finder & Saver/i);
  expect(heading).toBeInTheDocument();
});
