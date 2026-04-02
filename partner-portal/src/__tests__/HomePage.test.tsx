import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from '../pages/HomePage';
import * as api from '../api';


describe('HomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(api, 'fetchGraphs');
  });

  it('renders loading state initially', () => {
    // Return a promise that doesn't resolve immediately
    vi.mocked(api.fetchGraphs).mockReturnValue(new Promise(() => {}));
    
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    expect(screen.getByText('Loading services...')).toBeInTheDocument();
  });

  it('renders error state when fetch fails', async () => {
    vi.mocked(api.fetchGraphs).mockRejectedValue(new Error('API Error'));
    
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('API Error')).toBeInTheDocument();
    });
  });

  it('renders data when fetch succeeds', async () => {
    const mockData = {
      graphs: [
        {
          graph_id: 'g1',
          graph_name: 'Test Graph',
          services: [
            {
              service_id: 's1',
              title: 'Test Service',
              description: 'A test service',
              runtime: 'lambda',
            }
          ]
        }
      ],
      standalone: []
    };
    
    vi.mocked(api.fetchGraphs).mockResolvedValue(mockData as any);
    
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Test Graph')).toBeInTheDocument();
      expect(screen.getByText('Test Service')).toBeInTheDocument();
    });
  });
});