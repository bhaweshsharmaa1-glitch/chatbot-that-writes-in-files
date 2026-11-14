#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_FILENAME 100
#define MAX_FILE_BYTES (256 * 1024)

#ifdef _WIN32
#define PATH_SEPARATOR "\\"
#else
#define PATH_SEPARATOR "/"
#endif

static int is_filename_character(unsigned char character, int first) {
    if ((character >= 'A' && character <= 'Z') ||
        (character >= 'a' && character <= 'z') ||
        (character >= '0' && character <= '9')) {
        return 1;
    }
    return !first && (character == '.' || character == '_' || character == '-');
}

static char *build_target_path(const char *directory, const char *filename) {
    size_t directory_length = strlen(directory);
    size_t filename_length = strlen(filename);
    if (directory_length == 0 || filename_length == 0 || filename_length > MAX_FILENAME) return NULL;

    for (size_t index = 0; index < filename_length; index++) {
        unsigned char character = (unsigned char)filename[index];
        if (!is_filename_character(character, index == 0)) return NULL;
    }

    size_t path_length = directory_length + filename_length + 2;
    char *target_path = malloc(path_length);
    if (target_path == NULL) return NULL;
    int written = snprintf(target_path, path_length, "%s%s%s", directory, PATH_SEPARATOR, filename);
    if (written < 0 || (size_t)written >= path_length) {
        free(target_path);
        return NULL;
    }
    return target_path;
}

int main(int argument_count, char **arguments) {
    if (argument_count != 3) return 2;

    char *target_path = build_target_path(arguments[1], arguments[2]);
    if (target_path == NULL) return 2;

    unsigned char content[MAX_FILE_BYTES];
    size_t content_length = fread(content, 1, sizeof(content), stdin);
    if (ferror(stdin) || (content_length == sizeof(content) && fgetc(stdin) != EOF)) {
        free(target_path);
        return 3;
    }

    FILE *output = fopen(target_path, "wbx");
    if (output == NULL) {
        int result = errno == EEXIST ? 4 : 5;
        free(target_path);
        return result;
    }

    int succeeded = fwrite(content, 1, content_length, output) == content_length;
    if (fclose(output) != 0) succeeded = 0;
    if (!succeeded) remove(target_path);
    free(target_path);
    if (!succeeded) return 5;
    return 0;
}