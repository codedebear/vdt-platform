/**
 * Unit tests for updateProject and deleteProject service functions.
 * Prisma client is mocked so no real DB connection is needed.
 */
import { AppError } from '../src/middleware/errorHandler';

// Mock prisma before importing the service so the module receives the mock.
jest.mock('../src/config/prisma', () => ({
  prisma: {
    project: {
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

import { prisma } from '../src/config/prisma';
import { updateProject, deleteProject } from '../src/services/project.service';

const mockFindUnique = prisma.project.findUnique as jest.Mock;
const mockUpdate = prisma.project.update as jest.Mock;
const mockDelete = prisma.project.delete as jest.Mock;

const OWNER_ACTOR = { id: 'owner-1', role: 'PROJECT_OWNER' as const };
const ADMIN_ACTOR = { id: 'admin-1', role: 'SUPER_ADMIN' as const };
const OTHER_ACTOR = { id: 'other-1', role: 'PROJECT_OWNER' as const };
const PROJECT = { id: 'proj-1', ownerId: 'owner-1' };

describe('updateProject', () => {
  it('updates when actor is the project owner', async () => {
    mockFindUnique.mockResolvedValue(PROJECT);
    mockUpdate.mockResolvedValue({ ...PROJECT, name: 'New Name' });

    const result = await updateProject(OWNER_ACTOR, 'proj-1', { name: 'New Name' });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'proj-1' },
      data: { name: 'New Name' },
    });
    expect(result.name).toBe('New Name');
  });

  it('updates when actor is SUPER_ADMIN (not owner)', async () => {
    mockFindUnique.mockResolvedValue(PROJECT);
    mockUpdate.mockResolvedValue({ ...PROJECT, name: 'Admin Edit' });

    await expect(updateProject(ADMIN_ACTOR, 'proj-1', { name: 'Admin Edit' })).resolves.not.toThrow();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('throws 404 when project does not exist', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(updateProject(OWNER_ACTOR, 'missing', { name: 'X' })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('throws 403 when actor is not the owner', async () => {
    mockFindUnique.mockResolvedValue(PROJECT);

    await expect(updateProject(OTHER_ACTOR, 'proj-1', { name: 'X' })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('deleteProject', () => {
  it('deletes when actor is the project owner', async () => {
    mockFindUnique.mockResolvedValue(PROJECT);
    mockDelete.mockResolvedValue(PROJECT);

    await deleteProject(OWNER_ACTOR, 'proj-1');

    expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'proj-1' } });
  });

  it('deletes when actor is SUPER_ADMIN (not owner)', async () => {
    mockFindUnique.mockResolvedValue(PROJECT);
    mockDelete.mockResolvedValue(PROJECT);

    await expect(deleteProject(ADMIN_ACTOR, 'proj-1')).resolves.not.toThrow();
    expect(mockDelete).toHaveBeenCalled();
  });

  it('throws 404 when project does not exist', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(deleteProject(OWNER_ACTOR, 'missing')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('throws 403 when actor is not the owner', async () => {
    mockFindUnique.mockResolvedValue(PROJECT);

    await expect(deleteProject(OTHER_ACTOR, 'proj-1')).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
