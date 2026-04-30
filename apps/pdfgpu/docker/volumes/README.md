This folder is a placeholder for host-mounted volumes used by the pdfgpu service.

Create files or subfolders here that the container should consume at runtime.

Example mounts are configured in the root `docker-compose.yml`:
- `./apps/pdfgpu/docker/volumes` -> `/srv/volumes` inside the container
