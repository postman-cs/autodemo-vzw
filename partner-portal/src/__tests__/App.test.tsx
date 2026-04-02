import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';

describe('App', () => {
  it('renders without crashing and shows nav links', async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    expect(screen.getByText('Verizon Partner Portal')).toBeInTheDocument();
    expect(screen.getByText('Documentation')).toBeInTheDocument();
    expect(screen.getByText('Tools')).toBeInTheDocument();
    expect(screen.getByText('SDKs')).toBeInTheDocument();
    expect(screen.getByText('Support')).toBeInTheDocument();

    // Wait for the async fetch in HomePage to settle to avoid act() warnings
    await screen.findByText('Loading services...');
  });
});