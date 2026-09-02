import type { Request, Response } from 'express';
import type {
  CreateUserInput,
  SetUserModulesInput,
  UpdateUserInput,
  UserListQuery,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import * as service from './user.service.js';

export async function list(req: Request, res: Response): Promise<void> {
  const users = await service.listUsers(validatedQuery<UserListQuery>(req));
  sendSuccess(res, { users });
}

export async function detail(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  sendSuccess(res, { user: await service.getUser(id) });
}

export async function create(req: Request, res: Response): Promise<void> {
  const user = await service.createUser(req, currentUser(req).id, validatedBody<CreateUserInput>(req));
  sendCreated(res, { user });
}

export async function update(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const user = await service.updateUser(req, currentUser(req).id, id, validatedBody<UpdateUserInput>(req));
  sendSuccess(res, { user });
}

export async function setModules(req: Request, res: Response): Promise<void> {
  const { id } = validatedParams<{ id: string }>(req);
  const user = await service.setUserModules(
    req,
    currentUser(req).id,
    id,
    validatedBody<SetUserModulesInput>(req),
  );
  sendSuccess(res, { user });
}
