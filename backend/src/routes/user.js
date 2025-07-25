import bcrypt from 'bcrypt';
import imageCacheService from '../services/imageCache.js';
import BackupService from '../services/backupService.js';

async function userRoutes(fastify, options) {
  // Get user profile
  fastify.get('/profile', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const user = await fastify.prisma.user.findUnique({
        where: { id: request.user.userId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
          timezone: true,
          // themePreference removed
          createdAt: true,
          updatedAt: true
        }
      });

      if (!user) {
        return reply.status(404).send({ message: 'User not found' });
      }

      return reply.send({
        id: user.id,
        email: user.email,
        first_name: user.firstName,
        last_name: user.lastName,
        avatar_url: user.avatarUrl,
        timezone: user.timezone,
        // theme_preference removed
        created_at: user.createdAt.toISOString(),
        updated_at: user.updatedAt.toISOString()
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ message: 'Failed to fetch user profile' });
    }
  });

  // Update user profile
  fastify.patch('/profile', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { 
      email, 
      first_name, 
      last_name, 
      avatar_url, 
      timezone, 
      // theme_preference removed
    } = request.body;

    const updateData = {};

    if (email !== undefined) {
      // Check if email is already taken by another user
      if (email !== request.user.email) {
        const existingUser = await fastify.prisma.user.findUnique({
          where: { email }
        });
        
        if (existingUser) {
          return reply.status(400).send({ message: 'Email already in use' });
        }
      }
      updateData.email = email;
    }

    if (first_name !== undefined) updateData.firstName = first_name;
    if (last_name !== undefined) updateData.lastName = last_name;
    if (avatar_url !== undefined) updateData.avatarUrl = avatar_url;
    if (timezone !== undefined) updateData.timezone = timezone;
    // theme_preference removed

    if (Object.keys(updateData).length === 0) {
      return reply.status(400).send({ message: 'No valid fields to update' });
    }

    try {
      const updatedUser = await fastify.prisma.user.update({
        where: { id: request.user.userId },
        data: updateData,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
          timezone: true,
          // themePreference removed
          updatedAt: true
        }
      });

      return reply.send({
        id: updatedUser.id,
        email: updatedUser.email,
        first_name: updatedUser.firstName,
        last_name: updatedUser.lastName,
        avatar_url: updatedUser.avatarUrl,
        timezone: updatedUser.timezone,
        // theme_preference removed
        updated_at: updatedUser.updatedAt.toISOString()
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ message: 'Failed to update profile' });
    }
  });

  // Change password
  fastify.patch('/password', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { current_password, new_password } = request.body;

    if (!current_password || !new_password) {
      return reply.status(400).send({ 
        message: 'Current password and new password are required' 
      });
    }

    if (new_password.length < 6) {
      return reply.status(400).send({ 
        message: 'New password must be at least 6 characters long' 
      });
    }

    try {
      // Get current user with password
      const user = await fastify.prisma.user.findUnique({
        where: { id: request.user.userId },
        select: { password: true }
      });

      if (!user) {
        return reply.status(404).send({ message: 'User not found' });
      }

      // Verify current password
      const isValidPassword = await bcrypt.compare(current_password, user.password);
      if (!isValidPassword) {
        return reply.status(400).send({ message: 'Current password is incorrect' });
      }

      // Hash new password
      const hashedNewPassword = await bcrypt.hash(new_password, 10);

      // Update password
      await fastify.prisma.user.update({
        where: { id: request.user.userId },
        data: { password: hashedNewPassword }
      });

      return reply.send({ message: 'Password updated successfully' });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ message: 'Failed to update password' });
    }
  });

  // Get user API credentials
  fastify.get('/api-credentials', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const credentials = await fastify.prisma.userApiCredential.findMany({
        where: { userId: request.user.userId },
        select: {
          id: true,
          apiProvider: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
          // Don't send the actual credentials for security
        }
      });

      const formattedCredentials = credentials.map(cred => ({
        id: cred.id,
        api_provider: cred.apiProvider,
        is_active: cred.isActive,
        is_configured: true, // If it exists, it's configured
        created_at: cred.createdAt.toISOString(),
        updated_at: cred.updatedAt.toISOString()
      }));

      return reply.send(formattedCredentials);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ message: 'Failed to fetch API credentials' });
    }
  });

  // Add or update API credentials
  fastify.put('/api-credentials/:provider', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { provider } = request.params;
    const { 
      api_key, 
      client_id, 
      client_secret, 
      access_token, 
      refresh_token,
      expires_at,
      is_active = true 
    } = request.body;

    const supportedProviders = ['igdb', 'tmdb'];
    if (!supportedProviders.includes(provider)) {
      return reply.status(400).send({ 
        message: `Unsupported API provider. Supported: ${supportedProviders.join(', ')}` 
      });
    }

    // Validate required fields based on provider
    if (provider === 'igdb' && (!client_id || !access_token)) {
      return reply.status(400).send({ 
        message: 'IGDB requires client_id and access_token' 
      });
    }

    if (provider === 'tmdb' && !api_key) {
      return reply.status(400).send({ 
        message: 'TMDB requires api_key' 
      });
    }

    try {
      const credentialData = {
        userId: request.user.userId,
        apiProvider: provider,
        apiKey: api_key || null,
        clientId: client_id || null,
        clientSecret: client_secret || null,
        accessToken: access_token || null,
        refreshToken: refresh_token || null,
        expiresAt: expires_at ? new Date(expires_at) : null,
        isActive: is_active
      };

      const credential = await fastify.prisma.userApiCredential.upsert({
        where: {
          userId_apiProvider: {
            userId: request.user.userId,
            apiProvider: provider
          }
        },
        update: {
          ...credentialData,
          updatedAt: new Date()
        },
        create: credentialData
      });

      return reply.send({
        id: credential.id,
        api_provider: credential.apiProvider,
        is_active: credential.isActive,
        is_configured: true,
        created_at: credential.createdAt.toISOString(),
        updated_at: credential.updatedAt.toISOString()
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ message: 'Failed to save API credentials' });
    }
  });

  // Delete API credentials
  fastify.delete('/api-credentials/:provider', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { provider } = request.params;

    try {
      const deletedCredential = await fastify.prisma.userApiCredential.deleteMany({
        where: {
          userId: request.user.userId,
          apiProvider: provider
        }
      });

      if (deletedCredential.count === 0) {
        return reply.status(404).send({ 
          message: 'API credentials not found' 
        });
      }

      return reply.send({ 
        message: `${provider.toUpperCase()} credentials removed successfully` 
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ message: 'Failed to delete API credentials' });
    }
  });

  // Get image cache statistics
  fastify.get('/cache/stats', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const stats = await imageCacheService.getCacheStats();
      return reply.send(stats);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ message: 'Failed to get cache statistics' });
    }
  });

  // Handle OPTIONS preflight for backup endpoint
  fastify.options('/backup', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', request.headers.origin || '*');
    reply.header('Access-Control-Allow-Credentials', 'true');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    return reply.status(200).send();
  });

  // Create backup
  fastify.get('/backup', async (request, reply) => {
    try {
      // Set CORS headers explicitly
      reply.header('Access-Control-Allow-Origin', request.headers.origin || '*');
      reply.header('Access-Control-Allow-Credentials', 'true');
      
      // Handle authentication - check both header and query parameter
      let token = null;
      if (request.headers.authorization) {
        token = request.headers.authorization.replace('Bearer ', '');
      } else if (request.query.token) {
        token = request.query.token;
      }
      
      if (!token) {
        return reply.status(401).send({ message: 'Authentication required' });
      }
      
      // Verify JWT token manually
      try {
        const decoded = fastify.jwt.verify(token);
        const userId = decoded.userId;
        
        const backupService = new BackupService(fastify.prisma);
        const buffer = await backupService.createBackup(userId);
        
        const timestamp = new Date().toISOString().split('T')[0];
        const filename = `backlogus-backup-${timestamp}.zip`;
        
        reply.type('application/zip');
        reply.header('Content-Disposition', `attachment; filename="${filename}"`);
        
        return reply.send(buffer);
      } catch (jwtError) {
        return reply.status(401).send({ message: 'Invalid token' });
      }
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ message: 'Failed to create backup' });
    }
  });

  // Import backup
  fastify.post('/backup/import', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const userId = request.user.userId;
      
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ message: 'No backup file provided' });
      }

      const buffer = await data.toBuffer();
      
      const backupService = new BackupService(fastify.prisma);
      const result = await backupService.importBackup(userId, buffer);
      
      return reply.send(result);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ 
        message: 'Failed to import backup', 
        error: error.message 
      });
    }
  });
}

export default userRoutes;
